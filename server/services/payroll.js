'use strict';

/** Loading salaries and running payroll for a month. */

const { eachDay, diffDays, utcNow, hm } = require('../lib/dates');
const { computeComponents, round2 } = require('../engine/salary');
const { computePayslip } = require('../engine/payroll');
const { summarize, shiftForDay } = require('../engine/attendance');
const { leaveYearOf } = require('../engine/leave');
const { loadOrg, loadPolicies, loadShifts, fullName } = require('./common');
const { processRange, loadHolidays, holidayFor } = require('./attendance');
const { ensureAllocations } = require('./leave');
const { bad } = require('../lib/validate');

/**
 * The salary in force on a date for each employee:
 * Map employeeId → { salary, lines: [{ code, name, kind, amount, … }], errors, gross }.
 */
async function salariesOn(db, orgId, employeeIds, date) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const inIds = employeeIds.map(() => '?').join(',');
  const revisions = await db.all(
    `SELECT * FROM employee_salaries WHERE org_id = ? AND effective_from <= ? AND employee_id IN (${inIds}) ORDER BY employee_id, effective_from DESC, id DESC`,
    [orgId, date, ...employeeIds]);
  const latest = new Map();
  for (const r of revisions) if (!latest.has(r.employee_id)) latest.set(r.employee_id, r);
  const salaryIds = [...latest.values()].map((r) => r.id);
  const lines = salaryIds.length ? await db.all(
    `SELECT l.*, c.code, c.name, c.kind, c.taxable, c.attendance_based, c.prorate, c.show_on_payslip, c.sort
     FROM employee_salary_lines l JOIN salary_components c ON c.id = l.component_id
     WHERE l.salary_id IN (${salaryIds.map(() => '?').join(',')}) AND c.active = 1 ORDER BY c.sort, c.id`, salaryIds) : [];
  for (const [empId, salary] of latest) {
    const mine = lines.filter((l) => l.salary_id === salary.id);
    const { lines: computed, errors } = computeComponents(mine, { GROSS: Number(salary.gross) || 0 });
    out.set(empId, { salary, lines: computed, errors, gross: Number(salary.gross) || 0 });
  }
  return out;
}

/** A shift's normal working minutes (for hourly overtime). */
function shiftMinutes(shift) {
  let m = hm(shift.end_time) - hm(shift.start_time);
  if (m <= 0) m += 1440;
  m -= Number(shift.break_minutes) || 0;
  return m > 0 ? m : 480;
}

async function processRun(db, orgId, runId) {
  const org = await loadOrg(db, orgId);
  const run = await db.get('SELECT * FROM payroll_runs WHERE id = ? AND org_id = ?', [runId, orgId]);
  if (!run) throw bad('Payroll run not found.');
  if (!['draft', 'processed'].includes(run.status)) throw bad('This payroll is approved. Reopen it first to recalculate.');
  const { period_start: start, period_end: end } = run;
  const periodDays = diffDays(start, end) + 1;

  const employees = await db.all(
    `SELECT * FROM employees WHERE org_id = ? AND join_date <= ? AND (exit_date IS NULL OR exit_date >= ?) AND status <> 'onboarding' ORDER BY emp_code`,
    [orgId, end, start]);
  const ids = employees.map((e) => e.id);
  await processRange(db, orgId, { from: start, to: end, employeeIds: ids });

  const [shifts, policies, holidays, salaries] = await Promise.all([
    loadShifts(db, orgId), loadPolicies(db, orgId), loadHolidays(db, orgId, start, end), salariesOn(db, orgId, ids, end),
  ]);
  const days = ids.length ? await db.all(
    `SELECT * FROM attendance_days WHERE org_id = ? AND work_date >= ? AND work_date <= ? ORDER BY employee_id, work_date`, [orgId, start, end]) : [];
  const daysBy = new Map();
  for (const d of days) {
    if (!daysBy.has(d.employee_id)) daysBy.set(d.employee_id, []);
    daysBy.get(d.employee_id).push(d);
  }
  const adjustments = await db.all('SELECT * FROM adjustments WHERE org_id = ? AND month = ?', [orgId, run.month]);
  const loans = await db.all(
    `SELECT l.*, (SELECT COALESCE(SUM(r.amount), 0) FROM loan_repayments r WHERE r.loan_id = l.id AND (r.run_id IS NULL OR r.run_id <> ?)) AS repaid
     FROM loans l WHERE l.org_id = ? AND l.status = 'active' AND l.start_month <= ?`, [runId, orgId, run.month]);
  const slabs = await db.all('SELECT * FROM tax_slabs WHERE org_id = ?', [orgId]);
  const lookups = await db.all('SELECT id, name FROM departments WHERE org_id = ?', [orgId]);
  const deptName = new Map(lookups.map((d) => [d.id, d.name]));
  const desig = new Map((await db.all('SELECT id, name FROM designations WHERE org_id = ?', [orgId])).map((d) => [d.id, d.name]));

  // Leave that absences or lates can be taken from.
  const leaveType = await db.get('SELECT * FROM leave_types WHERE org_id = ? AND code = ? AND active = 1', [orgId, org.settings.deduction_leave_code]);
  const leaveYear = leaveYearOf(end, org.settings.leave_year_start_month);
  const leaveLeft = new Map();
  if (leaveType) {
    await ensureAllocations(db, org, leaveYear);
    const rows = await db.all(
      'SELECT employee_id, SUM(days) AS bal FROM leave_ledger WHERE org_id = ? AND leave_type_id = ? AND leave_year = ? GROUP BY employee_id',
      [orgId, leaveType.id, leaveYear]);
    rows.forEach((r) => leaveLeft.set(r.employee_id, Number(r.bal) || 0));
  }

  const slips = [];
  for (const e of employees) {
    const shift = (e.shift_id && shifts.byId.get(e.shift_id)) || shifts.default;
    const policy = (e.policy_id && policies.byId.get(e.policy_id)) || policies.default;
    const rules = policy.rules;
    const empStart = e.join_date > start ? e.join_date : start;
    const empEnd = e.exit_date && e.exit_date < end ? e.exit_date : end;
    const employedDays = diffDays(empStart, empEnd) + 1;

    let basisDays = periodDays;
    if (org.settings.payroll_day_basis === 'fixed30') basisDays = 30;
    if (org.settings.payroll_day_basis === 'working') {
      basisDays = eachDay(start, end).filter((d) => {
        if (shiftForDay(shift, d).off) return false;
        const h = holidayFor(holidays, d, e.branch_id);
        return !(h && (h.kind === 'public' || h.treatment === 'closed'));
      }).length || periodDays;
    }

    const sal = salaries.get(e.id);
    const components = sal ? sal.lines.map((l) => ({
      component_id: l.component_id, code: l.code, name: l.name, kind: l.kind, amount: l.amount, taxable: !!l.taxable,
      attendance_based: !!l.attendance_based, prorate: !!l.prorate, show_on_payslip: l.show_on_payslip, sort: l.sort,
    })) : [];
    const myDays = daysBy.get(e.id) || [];
    const attendance = summarize(myDays, rules);
    const pending = myDays.length < employedDays ? employedDays - myDays.length : 0; // days still in the future

    const result = computePayslip({
      period: { start, end, days: periodDays },
      basisDays,
      employedDays,
      components,
      gross: sal ? sal.gross : 0,
      attendance,
      rules,
      settings: org.settings,
      leaveAvailable: leaveLeft.get(e.id) || 0,
      shiftMinutes: shiftMinutes(shift),
      adjustments: adjustments.filter((a) => a.employee_id === e.id),
      loans: loans.filter((l) => l.employee_id === e.id).map((l) => ({ id: l.id, kind: l.kind, installment: l.installment, balance: Number(l.amount) - Number(l.repaid) })),
      slabs,
      taxExempt: !!e.tax_exempt,
    });
    if (sal && sal.errors.length) result.warnings.push(...sal.errors);
    if (pending) result.warnings.push(`${pending} day(s) of the period are still ahead: counted as paid.`);
    if (e.status === 'suspended') result.warnings.push('Employee is suspended: payslip on hold.');

    slips.push({
      employee: e,
      result,
      attendance,
      info: {
        name: fullName(e), emp_code: e.emp_code, department: deptName.get(e.department_id) || null, designation: desig.get(e.designation_id) || null,
        join_date: e.join_date, exit_date: e.exit_date, payment_method: e.payment_method, bank_name: e.bank_name, bank_account_title: e.bank_account_title,
        bank_account_no: e.bank_account_no, bank_iban: e.bank_iban, national_id: e.national_id, tax_number: e.tax_number, status: e.status,
        policy: policy.name, shift: shift.name, per_day: result.perDay,
      },
      basisDays, employedDays, gross: sal ? sal.gross : 0,
    });
  }

  const now = utcNow();
  const totals = { earnings: 0, deductions: 0, net: 0, gross: 0, employer: 0, tax: 0, employees: slips.length, warnings: 0 };
  await db.tx(async (t) => {
    const old = await t.all('SELECT id FROM payslips WHERE run_id = ?', [runId]);
    if (old.length) {
      const oldIds = old.map((o) => o.id);
      await t.run(`DELETE FROM payslip_lines WHERE payslip_id IN (${oldIds.map(() => '?').join(',')})`, oldIds);
      await t.run('DELETE FROM payslips WHERE run_id = ?', [runId]);
    }
    for (const s of slips) {
      const r = s.result;
      const a = s.attendance;
      const slipId = await t.insert('payslips', {
        org_id: orgId, run_id: runId, employee_id: s.employee.id, info: JSON.stringify(s.info),
        period_days: periodDays, basis_days: s.basisDays, employed_days: s.employedDays,
        present_days: a.present_days, paid_leave_days: a.paid_leave_days, unpaid_days: r.unpaidDays, absent_days: a.absent_days,
        half_days: a.half_days, late_count: a.late_count, late_deduction_days: r.lateDays, leave_adjusted_days: round2(r.leaveAdjusted),
        overtime_hours: r.otHours, gross: s.gross, earnings: r.earnings, deductions: r.deductions, net: r.net,
        on_hold: s.employee.status === 'suspended' ? 1 : 0, warnings: r.warnings.length ? JSON.stringify(r.warnings) : null, created_at: now,
      });
      for (const l of r.lines) {
        await t.insert('payslip_lines', {
          org_id: orgId, payslip_id: slipId, kind: l.kind, code: l.code, name: l.name.slice(0, 150), amount: l.amount,
          source: l.source, ref_id: l.ref_id, taxable: l.taxable, sort: l.sort,
        });
      }
      totals.earnings += r.earnings;
      totals.deductions += r.deductions;
      totals.net += r.net;
      totals.gross += s.gross;
      totals.employer += r.lines.filter((l) => l.kind === 'employer').reduce((x, l) => x + l.amount, 0);
      totals.tax += r.lines.filter((l) => l.source === 'tax').reduce((x, l) => x + l.amount, 0);
      if (r.warnings.length) totals.warnings++;
    }
    for (const k of ['earnings', 'deductions', 'net', 'gross', 'employer', 'tax']) totals[k] = round2(totals[k]);
    await t.update('payroll_runs', { id: runId }, {
      status: 'processed', processed_at: now, totals: JSON.stringify(totals), employee_count: slips.length,
    });
  });
  return totals;
}

/** Lock a processed run: record loan repayments and leave taken in place of salary deductions. */
async function approveRun(db, org, run, userId) {
  if (run.status !== 'processed') throw bad('Only a processed payroll can be approved.');
  const leaveType = await db.get('SELECT * FROM leave_types WHERE org_id = ? AND code = ?', [org.id, org.settings.deduction_leave_code]);
  const leaveYear = leaveYearOf(run.period_end, org.settings.leave_year_start_month);
  await db.tx(async (t) => {
    const now = utcNow();
    const loanLines = await t.all(
      `SELECT l.ref_id, l.amount, p.employee_id FROM payslip_lines l JOIN payslips p ON p.id = l.payslip_id
       WHERE p.run_id = ? AND l.source = 'loan' AND p.on_hold = 0`, [run.id]);
    for (const l of loanLines) {
      await t.insert('loan_repayments', { org_id: org.id, loan_id: l.ref_id, run_id: run.id, month: run.month, amount: l.amount, note: 'Payroll deduction', created_at: now });
      const loan = await t.get('SELECT amount, (SELECT COALESCE(SUM(amount), 0) FROM loan_repayments WHERE loan_id = ?) AS repaid FROM loans WHERE id = ?', [l.ref_id, l.ref_id]);
      if (loan && Number(loan.repaid) >= Number(loan.amount) - 0.005) await t.update('loans', { id: l.ref_id }, { status: 'closed' });
    }
    if (leaveType) {
      const slips = await t.all('SELECT employee_id, leave_adjusted_days FROM payslips WHERE run_id = ? AND leave_adjusted_days > 0', [run.id]);
      for (const s of slips) {
        await t.insert('leave_ledger', {
          org_id: org.id, employee_id: s.employee_id, leave_type_id: leaveType.id, leave_year: leaveYear, entry: 'payroll',
          days: -Number(s.leave_adjusted_days), run_id: run.id, note: `Absences/lates for ${run.month} taken from leave`, created_at: now,
        });
      }
    }
    await t.update('payroll_runs', { id: run.id }, { status: 'approved', approved_by: userId, approved_at: now });
  });
}

/** Undo approveRun so the month can be recalculated. */
async function reopenRun(db, org, run) {
  if (!['approved', 'paid'].includes(run.status)) throw bad('Only an approved payroll can be reopened.');
  await db.tx(async (t) => {
    const loanIds = (await t.all('SELECT DISTINCT loan_id FROM loan_repayments WHERE run_id = ?', [run.id])).map((r) => r.loan_id);
    await t.run('DELETE FROM loan_repayments WHERE run_id = ?', [run.id]);
    for (const id of loanIds) await t.update('loans', { id }, { status: 'active' });
    await t.run('DELETE FROM leave_ledger WHERE run_id = ?', [run.id]);
    await t.update('payroll_runs', { id: run.id }, { status: 'processed', approved_by: null, approved_at: null, paid_at: null });
  });
}

module.exports = { salariesOn, processRun, approveRun, reopenRun, shiftMinutes };
