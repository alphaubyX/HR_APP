'use strict';

const { need, inOrg } = require('../lib/auth');
const { nowIn, addDays, diffDays, isMonth, payPeriod } = require('../lib/dates');
const { employeeScope, fullName, loadPolicies } = require('../services/common');
const { processRange } = require('../services/attendance');
const { summarize } = require('../engine/attendance');
const { csv } = require('./payroll');

module.exports = function reportRoutes(r, { db }) {
  /** The home page: numbers and to-dos that fit the person's role. */
  r.get('/dashboard', inOrg, async (req, res) => {
    const orgId = req.org.id;
    const today = nowIn(req.org.timezone).date;
    const out = { today };
    const scope = await employeeScope(req);
    const empId = req.member.employee_id || 0;

    out.approvals = {
      leave: Number(await db.value(
        req.perms.has('leave.manage')
          ? "SELECT COUNT(*) FROM leave_requests WHERE org_id = ? AND status = 'pending' AND (approver_employee_id = ? OR approver_employee_id IS NULL)"
          : "SELECT COUNT(*) FROM leave_requests WHERE org_id = ? AND status = 'pending' AND approver_employee_id = ?", [orgId, empId])),
      corrections: Number(req.perms.has('attendance.manage')
        ? await db.value("SELECT COUNT(*) FROM regularizations WHERE org_id = ? AND status = 'pending'", [orgId])
        : await db.value("SELECT COUNT(*) FROM regularizations WHERE org_id = ? AND status = 'pending' AND approver_employee_id = ?", [orgId, empId])),
      requests: await require('../services/workflows').waitingCount(db, req),
    };

    if (scope.all || (scope.team && scope.team.size)) {
      let people = await db.all(
        "SELECT id, first_name, last_name, status, department_id, gender, join_date, probation_end, dob, emp_code FROM employees WHERE org_id = ? AND status NOT IN ('exited')", [orgId]);
      if (!scope.all) people = people.filter((p) => scope.team.has(p.id));
      const ids = people.filter((p) => p.status !== 'onboarding').map((p) => p.id);
      if (ids.length) await processRange(db, orgId, { from: today, to: today, employeeIds: ids });
      const days = ids.length ? await db.all(`SELECT employee_id, status, late_minutes, punch_count FROM attendance_days WHERE org_id = ? AND work_date = ? AND employee_id IN (${ids.map(() => '?').join(',')})`, [orgId, today, ...ids]) : [];
      const c = (fn) => days.filter(fn).length;
      out.today_attendance = {
        people: ids.length,
        in: c((d) => d.punch_count > 0),
        late: c((d) => d.late_minutes > 0),
        on_leave: c((d) => d.status === 'leave' || d.status === 'half_leave'),
        not_in: c((d) => d.punch_count === 0 && d.status === 'absent'),
        off: c((d) => d.status === 'weekend' || d.status === 'holiday'),
      };
      out.headcount = {
        total: people.length,
        probation: people.filter((p) => p.status === 'probation').length,
        permanent: people.filter((p) => p.status === 'permanent').length,
        onboarding: people.filter((p) => p.status === 'onboarding').length,
        notice: people.filter((p) => p.status === 'notice').length,
      };
      const depts = await db.all('SELECT id, name, color FROM departments WHERE org_id = ?', [orgId]);
      out.by_department = depts.map((d) => ({ name: d.name, color: d.color, count: people.filter((p) => p.department_id === d.id).length }))
        .concat([{ name: 'No department', color: '#94a3b8', count: people.filter((p) => !p.department_id).length }])
        .filter((d) => d.count).sort((a, b) => b.count - a.count);
      out.probation_due = people.filter((p) => p.status === 'probation' && p.probation_end && p.probation_end <= addDays(today, 30))
        .sort((a, b) => (a.probation_end < b.probation_end ? -1 : 1))
        .map((p) => ({ id: p.id, name: fullName(p), emp_code: p.emp_code, probation_end: p.probation_end, days_left: diffDays(today, p.probation_end) }));
      const md = (d) => d.slice(5);
      const soon = new Set(Array.from({ length: 14 }, (_, i) => md(addDays(today, i))));
      out.birthdays = people.filter((p) => p.dob && soon.has(md(p.dob))).map((p) => ({ id: p.id, name: fullName(p), date: md(p.dob) }))
        .sort((a, b) => ((((a.date < md(today)) ? '1' : '0') + a.date) < (((b.date < md(today)) ? '1' : '0') + b.date) ? -1 : 1));
      const anniv = people.filter((p) => p.join_date < today && soon.has(md(p.join_date)) && p.join_date.slice(0, 4) !== today.slice(0, 4));
      out.anniversaries = anniv.map((p) => ({ id: p.id, name: fullName(p), date: md(p.join_date), years: Number(today.slice(0, 4)) - Number(p.join_date.slice(0, 4)) }));
      out.on_leave_today = (await db.all(
        `SELECT r.employee_id, r.to_date, t.name AS type_name, t.color, e.first_name, e.last_name FROM leave_requests r JOIN employees e ON e.id = r.employee_id
         JOIN leave_types t ON t.id = r.leave_type_id WHERE r.org_id = ? AND r.status = 'approved' AND r.from_date <= ? AND r.to_date >= ?`, [orgId, today, today]))
        .filter((x) => scope.all || scope.team.has(x.employee_id)).map((x) => ({ ...x, name: fullName(x) }));
    }

    if (req.perms.has('payroll.view')) {
      const run = await db.get('SELECT * FROM payroll_runs WHERE org_id = ? ORDER BY month DESC LIMIT 1', [orgId]);
      out.last_payroll = run ? { id: run.id, month: run.month, status: run.status, totals: run.totals ? JSON.parse(run.totals) : null } : null;
      const trend = await db.all("SELECT month, totals FROM payroll_runs WHERE org_id = ? AND status IN ('processed', 'approved', 'paid') ORDER BY month DESC LIMIT 12", [orgId]);
      out.payroll_trend = trend.reverse().map((t) => ({ month: t.month, net: t.totals ? JSON.parse(t.totals).net : 0 }));
    }
    out.holidays = await db.all('SELECT holiday_date, name, kind, treatment FROM holidays WHERE org_id = ? AND holiday_date >= ? ORDER BY holiday_date LIMIT 5', [orgId, today]);
    res.json(out);
  });

  /* ---------------------------------------------------------------- reports */
  r.get('/reports/headcount.csv', need('reports.view'), async (req, res) => {
    const rows = await db.all(
      `SELECT e.*, d.name AS department, g.name AS designation, b.name AS branch, m.first_name AS mf, m.last_name AS ml
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations g ON g.id = e.designation_id
       LEFT JOIN branches b ON b.id = e.branch_id LEFT JOIN employees m ON m.id = e.manager_id
       WHERE e.org_id = ? ${req.query.all ? '' : "AND e.status <> 'exited'"} ORDER BY e.emp_code`, [req.org.id]);
    const out = [['Employee code', 'Name', 'Father name', 'Gender', 'Date of birth', 'National ID', 'Email', 'Phone', 'Department', 'Designation', 'Branch',
      'Line manager', 'Employment type', 'Status', 'Joined', 'Probation ends', 'Confirmed', 'Left', 'Machine number', 'Mobile attendance']];
    for (const e of rows) {
      out.push([e.emp_code, fullName(e), e.father_name, e.gender, e.dob, e.national_id, e.email, e.phone, e.department, e.designation, e.branch,
        e.mf ? [e.mf, e.ml].filter(Boolean).join(' ') : '', e.employment_type, e.status, e.join_date, e.probation_end, e.confirmed_on, e.exit_date, e.device_user_id, e.remote_attendance]);
    }
    sendCsv(res, 'employees', out);
  });

  r.get('/reports/attendance.csv', need('reports.view', 'attendance.view'), async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : nowIn(req.org.timezone).date.slice(0, 7);
    const { start, end } = payPeriod(month, req.org.settings.payroll_period_start_day);
    const emps = await db.all("SELECT * FROM employees WHERE org_id = ? AND join_date <= ? AND (exit_date IS NULL OR exit_date >= ?) AND status <> 'onboarding' ORDER BY emp_code", [req.org.id, end, start]);
    await processRange(db, req.org.id, { from: start, to: end, employeeIds: emps.map((e) => e.id) });
    const days = await db.all('SELECT * FROM attendance_days WHERE org_id = ? AND work_date >= ? AND work_date <= ?', [req.org.id, start, end]);
    const policies = await loadPolicies(db, req.org.id);
    const out = [['Employee code', 'Name', 'Days employed', 'Present', 'Absent', 'Half days', 'Paid leave', 'Unpaid leave', 'Off days', 'Lates', 'Late deduction days', 'Missing punches', 'Hours worked', 'Overtime hours', 'Deduction days']];
    for (const e of emps) {
      const rules = ((e.policy_id && policies.byId.get(e.policy_id)) || policies.default).rules;
      const s = summarize(days.filter((d) => d.employee_id === e.id), rules);
      out.push([e.emp_code, fullName(e), s.employed_days, s.present_days, s.absent_days, s.half_days, s.paid_leave_days, s.unpaid_leave_days, s.off_days, s.late_count,
        s.late_deduction_days, s.missing_days, Math.round(s.worked_minutes / 6) / 10, Math.round(s.ot_minutes / 6) / 10, s.deduction_days]);
    }
    sendCsv(res, `attendance-${month}`, out);
  });

  r.get('/reports/leave.csv', need('reports.view', 'leave.view'), async (req, res) => {
    const from = String(req.query.from || `${nowIn(req.org.timezone).date.slice(0, 4)}-01-01`);
    const to = String(req.query.to || `${from.slice(0, 4)}-12-31`);
    const rows = await db.all(
      `SELECT r.*, e.emp_code, e.first_name, e.last_name, t.name AS type_name FROM leave_requests r JOIN employees e ON e.id = r.employee_id
       JOIN leave_types t ON t.id = r.leave_type_id WHERE r.org_id = ? AND r.from_date <= ? AND r.to_date >= ? ORDER BY r.from_date`, [req.org.id, to, from]);
    const out = [['Employee code', 'Name', 'Leave type', 'From', 'To', 'Half day', 'Days', 'Status', 'Reason', 'Applied']];
    for (const x of rows) out.push([x.emp_code, fullName(x), x.type_name, x.from_date, x.to_date, x.half_day === 'none' ? '' : x.half_day, x.days, x.status, x.reason, x.created_at]);
    sendCsv(res, `leave-${from}-to-${to}`, out);
  });

  function sendCsv(res, name, rows) {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(`﻿${csv(rows)}`);
  }
};
