'use strict';

const { need, inOrg } = require('../lib/auth');
const { pick, bad, notFound, forbidden } = require('../lib/validate');
const { utcNow, nowIn, addDays } = require('../lib/dates');
const { leaveYearOf, leaveYearRange, countLeaveDays } = require('../engine/leave');
const { ensureAllocations, balances } = require('../services/leave');
const { buildChain, parseChain, canAct, decide, notifyStep, history, recordAction } = require('../services/approvals');
const { processRange } = require('../services/attendance');
const { audit, employeeScope, inScope, fullName, loadShifts, notifyEmployees } = require('../services/common');
const { crud } = require('./crud');

module.exports = function leaveRoutes(r, { db }) {
  crud(r, db, {
    path: 'leave-types', table: 'leave_types', perm: 'leave.manage', viewPerm: 'member', order: 'sort, name', label: 'Leave type',
    spec: {
      name: ['str', { required: true, max: 80 }], code: ['str', { required: true, max: 20 }], color: ['str', { max: 20 }],
      annual_quota: ['num', { min: 0, max: 366, default: 0 }], paid: ['bool'], carry_forward_max: ['num', { min: 0, max: 366, default: 0 }],
      allow_half_day: ['bool'], allow_in_probation: ['bool'], prorate_on_join: ['bool'], count_off_days: ['bool'],
      gender: ['str', { oneOf: ['any', 'male', 'female'], default: 'any' }], min_notice_days: ['int', { min: 0, max: 365, default: 0 }],
      max_days_per_request: ['num', { min: 0, max: 366 }], allow_negative: ['bool'], sort: ['int', { min: 0, max: 1000, default: 0 }], active: ['bool'],
    },
    async beforeSave(req, data) {
      if (data.code) {
        data.code = data.code.toUpperCase();
        if (!/^[A-Z0-9_]{1,20}$/.test(data.code)) throw bad('Code: capital letters and numbers only.');
      }
    },
    async beforeDelete(req, row) {
      const n = Number(await db.value('SELECT COUNT(*) FROM leave_requests WHERE leave_type_id = ?', [row.id])) + Number(await db.value('SELECT COUNT(*) FROM leave_ledger WHERE leave_type_id = ?', [row.id]));
      if (n) throw bad('This leave type has been used. Switch it off (untick Active) instead.');
    },
  });

  async function visibleEmployee(req, id, perm = 'leave.view') {
    const empId = Number(id) || req.member.employee_id;
    if (!empId) throw bad('Your account is not linked to an employee record.');
    const e = await db.get('SELECT * FROM employees WHERE id = ? AND org_id = ?', [empId, req.org.id]);
    if (!e) throw notFound('Employee');
    const scope = await employeeScope(req, perm);
    if (!inScope(scope, e.id)) throw forbidden('You can only see your own team.');
    return e;
  }

  const today = (req) => nowIn(req.org.timezone).date;
  const currentYear = (req) => leaveYearOf(today(req), req.org.settings.leave_year_start_month);

  r.get('/leave/balances', inOrg, async (req, res) => {
    const e = await visibleEmployee(req, req.query.employee_id);
    const year = Number(req.query.year) || currentYear(req);
    res.json({ year, range: leaveYearRange(year, req.org.settings.leave_year_start_month), balances: await balances(db, req.org, e, year) });
  });

  /** Balances of everyone (or a team) for one leave year: the leave register. */
  r.get('/leave/register', need('leave.view', 'leave.manage'), async (req, res) => {
    const year = Number(req.query.year) || currentYear(req);
    await ensureAllocations(db, req.org, year);
    const types = await db.all('SELECT id, name, code, color FROM leave_types WHERE org_id = ? AND active = 1 ORDER BY sort, name', [req.org.id]);
    const people = await db.all("SELECT id, emp_code, first_name, last_name, department_id, gender FROM employees WHERE org_id = ? AND status <> 'exited' ORDER BY first_name", [req.org.id]);
    const sums = await db.all('SELECT employee_id, leave_type_id, entry, SUM(days) AS days FROM leave_ledger WHERE org_id = ? AND leave_year = ? GROUP BY employee_id, leave_type_id, entry', [req.org.id, year]);
    const map = new Map();
    for (const s of sums) {
      const k = `${s.employee_id}|${s.leave_type_id}`;
      if (!map.has(k)) map.set(k, { entitled: 0, used: 0, balance: 0 });
      const m = map.get(k);
      const d = Number(s.days);
      m.balance += d;
      if (['allocation', 'carry_forward', 'adjustment'].includes(s.entry)) m.entitled += d;
      if (['taken', 'cancelled', 'payroll'].includes(s.entry)) m.used -= d;
    }
    res.json({
      year, types,
      rows: people.map((p) => ({
        id: p.id, emp_code: p.emp_code, name: fullName(p), department_id: p.department_id,
        balances: Object.fromEntries(types.map((t) => [t.id, map.get(`${p.id}|${t.id}`) || null])),
      })),
    });
  });

  r.get('/leave/ledger', inOrg, async (req, res) => {
    const e = await visibleEmployee(req, req.query.employee_id);
    const year = Number(req.query.year) || currentYear(req);
    await ensureAllocations(db, req.org, year);
    res.json(await db.all(
      `SELECT l.*, t.name AS type_name, t.code AS type_code, t.color, u.name AS user_name FROM leave_ledger l
       JOIN leave_types t ON t.id = l.leave_type_id LEFT JOIN users u ON u.id = l.user_id
       WHERE l.org_id = ? AND l.employee_id = ? AND l.leave_year = ? ORDER BY l.created_at, l.id`, [req.org.id, e.id, year]));
  });

  /** HR corrects a balance: + adds days, − removes days. */
  r.post('/leave/ledger', need('leave.manage'), async (req, res) => {
    const b = pick(req.body, {
      employee_id: ['id', { required: true }], leave_type_id: ['id', { required: true }], year: ['int', { min: 2000, max: 2100 }],
      days: ['num', { required: true, min: -366, max: 366 }], note: ['str', { required: true, max: 200 }],
    });
    if (!b.days) throw bad('Days cannot be 0.');
    await visibleEmployee(req, b.employee_id);
    if (!(await db.get('SELECT id FROM leave_types WHERE id = ? AND org_id = ?', [b.leave_type_id, req.org.id]))) throw bad('Leave type not found.');
    const year = b.year || currentYear(req);
    await ensureAllocations(db, req.org, year);
    await db.insert('leave_ledger', { org_id: req.org.id, employee_id: b.employee_id, leave_type_id: b.leave_type_id, leave_year: year, entry: 'adjustment', days: b.days, note: b.note, user_id: req.user.id, created_at: utcNow() });
    await audit(db, req, 'leave.adjust', 'employees', b.employee_id, b);
    res.json({ ok: true });
  });

  r.post('/leave/allocate', need('leave.manage'), async (req, res) => {
    const year = Number(req.body?.year) || currentYear(req);
    res.json({ created: await ensureAllocations(db, req.org, year) });
  });

  /** Check a leave before applying: days it takes and whether the balance covers it. */
  async function evaluate(req, e, body, { onBehalf = false } = {}) {
    const b = pick(body, {
      leave_type_id: ['id', { required: true }], from_date: ['date', { required: true }], to_date: ['date'],
      half_day: ['str', { oneOf: ['none', 'first', 'second'], default: 'none' }], reason: ['str', { max: 500 }],
    });
    if (!b.to_date) b.to_date = b.from_date;
    if (b.to_date < b.from_date) throw bad('The leave cannot end before it starts.');
    const type = await db.get('SELECT * FROM leave_types WHERE id = ? AND org_id = ? AND active = 1', [b.leave_type_id, req.org.id]);
    if (!type) throw bad('Leave type not found.');
    if (type.gender !== 'any' && e.gender && e.gender !== type.gender) throw bad(`${type.name} is not available to this employee.`);
    if (['exited'].includes(e.status)) throw bad('This employee has left.');
    if (e.status === 'probation' && !type.allow_in_probation) throw bad(`${type.name} can be taken only after probation ends${e.probation_end ? ` (${e.probation_end})` : ''}.`);
    if (b.half_day !== 'none') {
      if (!type.allow_half_day) throw bad(`${type.name} cannot be taken as a half day.`);
      if (b.from_date !== b.to_date) throw bad('A half-day leave is for one day only.');
    }
    const sm = req.org.settings.leave_year_start_month;
    const year = leaveYearOf(b.from_date, sm);
    if (leaveYearOf(b.to_date, sm) !== year) throw bad(`The leave crosses into the next leave year. Please make two requests, one ending ${leaveYearRange(year, sm).end}.`);
    if (!onBehalf && type.min_notice_days && b.from_date < addDays(today(req), type.min_notice_days)) {
      throw bad(`${type.name} needs ${type.min_notice_days} day(s) notice.`);
    }
    const shifts = await loadShifts(db, req.org.id);
    const shift = (e.shift_id && shifts.byId.get(e.shift_id)) || shifts.default;
    const hol = await db.all(
      "SELECT holiday_date FROM holidays WHERE org_id = ? AND holiday_date >= ? AND holiday_date <= ? AND (kind = 'public' OR treatment = 'closed') AND (branch_id IS NULL OR branch_id = ?)",
      [req.org.id, b.from_date, b.to_date, e.branch_id || 0]);
    const days = countLeaveDays({ from: b.from_date, to: b.to_date, half: b.half_day, shift, holidayDates: new Set(hol.map((h) => h.holiday_date)), countOffDays: !!type.count_off_days });
    if (!days) throw bad('Those dates are all weekends or holidays: no leave needed.');
    if (type.max_days_per_request && days > type.max_days_per_request) throw bad(`At most ${type.max_days_per_request} day(s) of ${type.name} in one request.`);
    const overlap = await db.get(
      "SELECT id, from_date, to_date FROM leave_requests WHERE org_id = ? AND employee_id = ? AND status IN ('pending', 'approved') AND from_date <= ? AND to_date >= ?",
      [req.org.id, e.id, b.to_date, b.from_date]);
    if (overlap) throw bad(`There is already a leave request for ${overlap.from_date}${overlap.to_date !== overlap.from_date ? ` – ${overlap.to_date}` : ''}.`);
    const bal = (await balances(db, req.org, e, year)).find((x) => x.leave_type_id === type.id);
    const available = bal ? bal.available : 0;
    const enough = !!type.allow_negative || available >= days;
    return { b, type, days, year, available, enough };
  }

  r.post('/leave/preview', inOrg, async (req, res) => {
    const e = await visibleEmployee(req, req.body?.employee_id);
    try {
      const v = await evaluate(req, e, req.body, { onBehalf: e.id !== req.member.employee_id });
      const { steps } = await buildChain(db, req.org, e.id, today(req));
      res.json({ ok: true, days: v.days, available: v.available, enough: v.enough, unlimited: !!v.type.allow_negative, chain: steps });
    } catch (err) {
      if (err.status === 400) return res.json({ ok: false, error: err.message });
      throw err;
    }
  });

  async function finalizeApproved(row, req) {
    const type = await db.get('SELECT * FROM leave_types WHERE id = ?', [row.leave_type_id]);
    const year = leaveYearOf(row.from_date, req.org.settings.leave_year_start_month);
    await db.insert('leave_ledger', {
      org_id: row.org_id, employee_id: row.employee_id, leave_type_id: row.leave_type_id, leave_year: year, entry: 'taken', days: -Number(row.days),
      request_id: row.id, note: `${type ? type.name : 'Leave'} ${row.from_date}${row.to_date !== row.from_date ? ` to ${row.to_date}` : ''}`, user_id: req.user.id, created_at: utcNow(),
    });
    await processRange(db, row.org_id, { from: row.from_date, to: row.to_date, employeeIds: [row.employee_id] });
  }

  r.post('/leave/requests', inOrg, async (req, res) => {
    const e = await visibleEmployee(req, req.body?.employee_id, 'leave.manage');
    const onBehalf = e.id !== req.member.employee_id;
    if (onBehalf && !req.perms.has('leave.manage')) throw forbidden('Only HR can apply on someone else\'s behalf.');
    const v = await evaluate(req, e, req.body, { onBehalf });
    if (!v.enough) throw bad(`Not enough ${v.type.name}: ${v.available} day(s) available, ${v.days} requested.`);
    const { steps } = await buildChain(db, req.org, e.id, today(req));
    const now = utcNow();
    const first = steps[0];
    const id = await db.insert('leave_requests', {
      org_id: req.org.id, employee_id: e.id, leave_type_id: v.type.id, from_date: v.b.from_date, to_date: v.b.to_date, half_day: v.b.half_day,
      days: v.days, reason: v.b.reason, status: 'pending', chain: JSON.stringify(steps), step: 0, step_since: now,
      approver_employee_id: first.type === 'employee' ? first.id : null, created_by: req.user.id, created_at: now,
    });
    let row = await db.get('SELECT * FROM leave_requests WHERE id = ?', [id]);
    await recordAction(db, req, 'leave', row, 'submitted', onBehalf ? 'Entered by HR' : null);
    if (onBehalf && req.body.approve_now) {
      await decide(db, req, 'leave_requests', 'leave', row, true, 'Approved by HR when entered');
      row = await db.get('SELECT * FROM leave_requests WHERE id = ?', [id]);
      await finalizeApproved(row, req);
    } else {
      await notifyStep(db, req.org, row, 'leave', `${fullName(e)} asks for ${v.days} day(s) of ${v.type.name} from ${v.b.from_date}`);
    }
    await audit(db, req, 'leave.apply', 'leave_requests', id, { employee: fullName(e), days: v.days, type: v.type.code });
    res.json({ id, status: row.status });
  });

  async function decorateRequests(rows) {
    return rows.map((x) => ({ ...x, name: fullName(x), chain: parseChain(x) }));
  }

  /**
   * scope = mine | approvals (waiting for me) | team (my people) | all (HR)
   */
  r.get('/leave/requests', inOrg, async (req, res) => {
    const scopeName = String(req.query.scope || 'mine');
    let sql = `SELECT r.*, e.first_name, e.last_name, e.emp_code, e.department_id, t.name AS type_name, t.code AS type_code, t.color
               FROM leave_requests r JOIN employees e ON e.id = r.employee_id JOIN leave_types t ON t.id = r.leave_type_id
               WHERE r.org_id = ?`;
    const params = [req.org.id];
    if (scopeName === 'mine') {
      sql += ' AND r.employee_id = ?'; params.push(req.member.employee_id || 0);
    } else if (scopeName === 'approvals') {
      if (req.perms.has('leave.manage')) {
        sql += " AND r.status = 'pending' AND (r.approver_employee_id = ? OR r.approver_employee_id IS NULL OR ? = 1)";
        params.push(req.member.employee_id || 0, req.query.everything ? 1 : 0);
      } else {
        sql += " AND r.status = 'pending' AND r.approver_employee_id = ?"; params.push(req.member.employee_id || 0);
      }
    } else if (scopeName === 'team' || scopeName === 'all') {
      const scope = await employeeScope(req, 'leave.view');
      if (!scope.all) {
        const ids = [...(scope.team || [])];
        if (!ids.length) return res.json([]);
        sql += ` AND r.employee_id IN (${ids.map(() => '?').join(',')})`; params.push(...ids);
      }
    }
    if (req.query.status) { sql += ' AND r.status = ?'; params.push(String(req.query.status)); }
    if (req.query.from) { sql += ' AND r.to_date >= ?'; params.push(String(req.query.from)); }
    if (req.query.to) { sql += ' AND r.from_date <= ?'; params.push(String(req.query.to)); }
    if (req.query.employee_id) { sql += ' AND r.employee_id = ?'; params.push(Number(req.query.employee_id)); }
    sql += ' ORDER BY r.from_date DESC, r.id DESC LIMIT 500';
    const rows = await decorateRequests(await db.all(sql, params));
    res.json(rows.map((x) => ({ ...x, can_act: canAct(req, x, 'leave.manage') })));
  });

  async function loadRequest(req, id) {
    const row = await db.get('SELECT * FROM leave_requests WHERE id = ? AND org_id = ?', [id, req.org.id]);
    if (!row) throw notFound('Leave request');
    return row;
  }

  r.get('/leave/requests/:id', inOrg, async (req, res) => {
    const row = await loadRequest(req, req.params.id);
    const scope = await employeeScope(req, 'leave.view');
    const chain = parseChain(row);
    const isApprover = chain.some((s) => s.type === 'employee' && s.id === req.member.employee_id);
    if (!inScope(scope, row.employee_id) && !isApprover) throw forbidden();
    const e = await db.get('SELECT first_name, last_name, emp_code FROM employees WHERE id = ?', [row.employee_id]);
    const type = await db.get('SELECT name, code, color FROM leave_types WHERE id = ?', [row.leave_type_id]);
    const year = leaveYearOf(row.from_date, req.org.settings.leave_year_start_month);
    const emp = await db.get('SELECT * FROM employees WHERE id = ?', [row.employee_id]);
    res.json({
      ...row, chain, name: fullName(e), emp_code: e.emp_code, type_name: type.name, type_code: type.code, color: type.color,
      history: await history(db, 'leave', row.id), can_act: canAct(req, row, 'leave.manage'),
      balance: (await balances(db, req.org, emp, year)).find((b) => b.leave_type_id === row.leave_type_id) || null,
    });
  });

  r.post('/leave/requests/:id/decide', inOrg, async (req, res) => {
    const row = await loadRequest(req, req.params.id);
    if (!canAct(req, row, 'leave.manage')) throw forbidden('This request is not waiting for you.');
    const approve = !!req.body?.approve;
    const comment = req.body?.comment ? String(req.body.comment).slice(0, 500) : null;
    if (!approve && !comment) throw bad('Please give a reason for rejecting.');
    if (row.employee_id === req.member.employee_id && !req.perms.has('leave.manage')) throw forbidden('You cannot approve your own leave.');
    if (approve) {
      // the balance may have changed since the request was made
      const type = await db.get('SELECT * FROM leave_types WHERE id = ?', [row.leave_type_id]);
      const e = await db.get('SELECT * FROM employees WHERE id = ?', [row.employee_id]);
      const bal = (await balances(db, req.org, e, leaveYearOf(row.from_date, req.org.settings.leave_year_start_month))).find((b) => b.leave_type_id === row.leave_type_id);
      if (!type.allow_negative && bal && bal.balance < Number(row.days)) throw bad(`Only ${bal.balance} day(s) of ${type.name} left.`);
    }
    const result = await decide(db, req, 'leave_requests', 'leave', row, approve, comment);
    const fresh = await loadRequest(req, row.id);
    const e = await db.get('SELECT first_name, last_name FROM employees WHERE id = ?', [row.employee_id]);
    if (result === 'approved') {
      await finalizeApproved(fresh, req);
      await notifyEmployees(db, req.org.id, [row.employee_id], `Your leave from ${row.from_date} was approved`, comment, '#/me/leave');
    } else if (result === 'rejected') {
      await notifyEmployees(db, req.org.id, [row.employee_id], `Your leave from ${row.from_date} was not approved`, comment, '#/me/leave');
    } else {
      await notifyStep(db, req.org, fresh, 'leave', `${fullName(e)}'s leave from ${row.from_date} needs your approval`);
    }
    await audit(db, req, `leave.${result}`, 'leave_requests', row.id, { comment });
    res.json({ status: fresh.status, result });
  });

  r.post('/leave/requests/:id/cancel', inOrg, async (req, res) => {
    const row = await loadRequest(req, req.params.id);
    const own = row.employee_id === req.member.employee_id;
    const hr = req.perms.has('leave.manage');
    if (!own && !hr) throw forbidden();
    if (!['pending', 'approved'].includes(row.status)) throw bad('This request is already closed.');
    if (row.status === 'approved' && !hr && row.from_date <= today(req)) throw bad('This leave has started. Ask HR to cancel it.');
    await db.update('leave_requests', { id: row.id }, { status: 'cancelled', decided_at: utcNow(), approver_employee_id: null });
    await recordAction(db, req, 'leave', row, 'cancelled', req.body?.comment || null);
    if (row.status === 'approved') {
      const year = leaveYearOf(row.from_date, req.org.settings.leave_year_start_month);
      await db.insert('leave_ledger', {
        org_id: row.org_id, employee_id: row.employee_id, leave_type_id: row.leave_type_id, leave_year: year, entry: 'cancelled', days: Number(row.days),
        request_id: row.id, note: 'Leave cancelled', user_id: req.user.id, created_at: utcNow(),
      });
      await processRange(db, row.org_id, { from: row.from_date, to: row.to_date, employeeIds: [row.employee_id] });
    }
    if (!own) await notifyEmployees(db, req.org.id, [row.employee_id], `Your leave from ${row.from_date} was cancelled by HR`, null, '#/me/leave');
    await audit(db, req, 'leave.cancel', 'leave_requests', row.id);
    res.json({ ok: true });
  });

  /** Who is away when: approved and pending leave of the people you can see, plus holidays. */
  r.get('/leave/calendar', inOrg, async (req, res) => {
    const from = String(req.query.from || today(req).slice(0, 8) + '01');
    const to = String(req.query.to || addDays(from, 41));
    const scope = await employeeScope(req, 'leave.view');
    let sql = `SELECT r.id, r.employee_id, r.from_date, r.to_date, r.half_day, r.days, r.status, e.first_name, e.last_name, e.department_id, t.name AS type_name, t.code AS type_code, t.color
               FROM leave_requests r JOIN employees e ON e.id = r.employee_id JOIN leave_types t ON t.id = r.leave_type_id
               WHERE r.org_id = ? AND r.status IN ('approved', 'pending') AND r.from_date <= ? AND r.to_date >= ?`;
    const params = [req.org.id, to, from];
    if (!scope.all) {
      // your team, and the people who share your manager
      const me = await db.get('SELECT manager_id FROM employees WHERE id = ?', [req.member.employee_id || 0]);
      const peers = me && me.manager_id ? (await db.all("SELECT id FROM employees WHERE org_id = ? AND manager_id = ? AND status <> 'exited'", [req.org.id, me.manager_id])).map((x) => x.id) : [];
      const ids = [...new Set([...scope.ids, ...peers])];
      if (!ids.length) return res.json({ leaves: [], holidays: [] });
      sql += ` AND r.employee_id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }
    const leaves = (await db.all(sql, params)).map((x) => ({ ...x, name: fullName(x) }));
    const holidays = await db.all('SELECT * FROM holidays WHERE org_id = ? AND holiday_date >= ? AND holiday_date <= ? ORDER BY holiday_date', [req.org.id, from, to]);
    res.json({ leaves, holidays });
  });
};
