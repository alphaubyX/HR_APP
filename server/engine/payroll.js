'use strict';

/**
 * Payslip calculation, given everything already loaded. Pure: the routes load the data and save the
 * result. Amounts are monthly; the order of the steps is:
 *   1. earnings per the salary definition, prorated for joining/leaving in the period
 *   2. absence / unpaid-leave / late deductions at the daily rate, after using leave balance if the policy says so
 *   3. overtime at the hourly rate
 *   4. one-off adjustments, loan installments, deduction components
 *   5. income tax from the slabs on the annualized taxable income
 */

const { round2 } = require('./salary');

/** Tax on an annual income using slabs [{ from_amount, to_amount, fixed_tax, rate }]. */
function annualTax(income, slabs) {
  const sorted = [...slabs].sort((a, b) => a.from_amount - b.from_amount);
  let slab = null;
  for (const s of sorted) {
    if (income > Number(s.from_amount) && (s.to_amount === null || s.to_amount === undefined || income <= Number(s.to_amount))) slab = s;
  }
  if (!slab) {
    // above the last slab with an upper bound: use the highest one that starts below the income
    slab = sorted.filter((s) => income > Number(s.from_amount)).pop() || null;
  }
  if (!slab) return 0;
  return Number(slab.fixed_tax) + (income - Number(slab.from_amount)) * (Number(slab.rate) / 100);
}

function roundNet(n, mode) {
  if (mode === 'unit') return Math.round(n);
  if (mode === 'ten') return Math.round(n / 10) * 10;
  return round2(n);
}

/**
 * input = {
 *   period: { start, end, days },          basisDays: number,  employedDays: number,
 *   components: [{ code, name, kind, amount, taxable, attendance_based, prorate, show_on_payslip, component_id, sort }],
 *   gross: monthly gross per contract,
 *   attendance: summary from attendance.summarize(), or null when attendance isn't tracked
 *   rules: policy rules, settings: org settings,
 *   leaveAvailable: days left in the deduction leave type (for "leave then salary"),
 *   shiftMinutes: a normal working day in minutes (for the hourly rate),
 *   adjustments: [{ id, kind, title, amount, taxable }],
 *   loans: [{ id, kind, installment, balance }],
 *   slabs: tax slabs, taxExempt: bool,
 * }
 */
function computePayslip(input) {
  const {
    period, basisDays, employedDays, components, gross, attendance, rules, settings,
    leaveAvailable = 0, shiftMinutes = 480, adjustments = [], loans = [], slabs = [], taxExempt = false,
  } = input;
  const lines = [];
  const warnings = [];
  let sort = 0;
  const add = (kind, name, amount, source, extra = {}) => {
    amount = round2(amount);
    if (!amount && !extra.keepZero) return;
    lines.push({ kind, name, amount, source, code: extra.code || null, ref_id: extra.ref_id || null, taxable: extra.taxable ? 1 : 0, sort: sort++, show: extra.show !== false });
  };

  // 1. Earnings, prorated for days employed in the period.
  const factor = period.days > 0 ? Math.min(1, employedDays / period.days) : 1;
  if (factor < 1) warnings.push(`Employed ${employedDays} of ${period.days} days: salary prorated.`);
  let attendanceBase = 0; // monthly earnings that attendance deductions apply to
  let taxableAttendanceBase = 0;
  for (const c of components) {
    if (c.kind !== 'earning') continue;
    const amount = c.prorate ? c.amount * factor : c.amount;
    add('earning', c.name, amount, 'component', { code: c.code, ref_id: c.component_id, taxable: c.taxable, show: c.show_on_payslip !== 0 });
    if (c.attendance_based) {
      attendanceBase += c.amount;
      if (c.taxable) taxableAttendanceBase += c.amount;
    }
  }
  const perDay = basisDays > 0 ? attendanceBase / basisDays : 0;

  // 2. Attendance deductions.
  const out = {
    absenceDays: 0, lateDays: 0, leaveAdjusted: 0, unpaidDays: 0, perDay: round2(perDay), otHours: 0,
  };
  if (attendance) {
    let absence = attendance.deduction_days; // absences, half days, short time and unpaid leave
    let lateDays = attendance.late_deduction_days || 0;
    let available = Math.max(0, Number(leaveAvailable) || 0);
    if (rules.absent_deduct_from === 'leave_then_salary' && available > 0) {
      const fromLeave = Math.min(available, attendance.absence_deduction_days);
      out.leaveAdjusted += fromLeave;
      absence -= fromLeave;
      available -= fromLeave;
    }
    if (rules.late_deduct_from === 'leave_then_salary' && available > 0 && lateDays > 0) {
      const fromLeave = Math.min(available, lateDays);
      out.leaveAdjusted += fromLeave;
      lateDays -= fromLeave;
    }
    out.absenceDays = Math.max(0, round2(absence));
    out.lateDays = Math.max(0, round2(lateDays));
    out.unpaidDays = round2(out.absenceDays + out.lateDays);
    if (out.absenceDays) {
      add('deduction', `Absences / unpaid leave (${out.absenceDays} day${out.absenceDays === 1 ? '' : 's'})`, perDay * out.absenceDays, 'attendance');
    }
    if (out.lateDays) {
      add('deduction', `Late arrivals (${attendance.late_count} lates = ${out.lateDays} day${out.lateDays === 1 ? '' : 's'})`, perDay * out.lateDays, 'late');
    }
    if (out.leaveAdjusted) warnings.push(`${round2(out.leaveAdjusted)} day(s) of absences/lates taken from leave balance instead of salary.`);
    if (attendance.missing_days) warnings.push(`${attendance.missing_days} day(s) with a missing punch (counted as present).`);

    // 3. Overtime.
    if (rules.overtime_enabled && attendance.ot_minutes > 0) {
      let weighted = attendance.ot_weighted_minutes;
      let hours = attendance.ot_minutes / 60;
      const cap = rules.overtime_max_hours_month;
      if (cap > 0 && hours > cap) {
        weighted *= cap / hours;
        hours = cap;
        warnings.push(`Overtime capped at ${cap} hours.`);
      }
      out.otHours = round2(hours);
      const hourly = shiftMinutes > 0 ? perDay / (shiftMinutes / 60) : 0;
      add('earning', `Overtime (${out.otHours} h)`, (weighted / 60) * hourly, 'overtime', { taxable: true });
    }
  }

  // 4. Adjustments, deduction components, loans, employer contributions.
  for (const a of adjustments) {
    add(a.kind === 'deduction' ? 'deduction' : 'earning', a.title, Number(a.amount), 'adjustment', { ref_id: a.id, taxable: a.kind !== 'deduction' && a.taxable });
  }
  for (const c of components) {
    if (c.kind === 'deduction') add('deduction', c.name, c.prorate ? c.amount * factor : c.amount, 'component', { code: c.code, ref_id: c.component_id, show: c.show_on_payslip !== 0 });
    if (c.kind === 'employer') add('employer', c.name, c.prorate ? c.amount * factor : c.amount, 'component', { code: c.code, ref_id: c.component_id });
  }
  for (const l of loans) {
    const amount = Math.min(Number(l.installment), Number(l.balance));
    if (amount > 0) add('deduction', l.kind === 'advance' ? 'Advance salary recovery' : 'Loan installment', amount, 'loan', { ref_id: l.id });
  }

  // 5. Income tax.
  const sum = (kind, pred = () => true) => lines.filter((l) => l.kind === kind && pred(l)).reduce((a, l) => a + l.amount, 0);
  let taxableMonthly = sum('earning', (l) => l.taxable);
  if (attendanceBase > 0) {
    const attendanceDeductions = sum('deduction', (l) => l.source === 'attendance' || l.source === 'late');
    taxableMonthly -= attendanceDeductions * (taxableAttendanceBase / attendanceBase);
  }
  taxableMonthly = Math.max(0, taxableMonthly);
  if (settings.tax_enabled && !taxExempt && slabs.length) {
    const tax = annualTax(taxableMonthly * 12, slabs) / 12;
    add('deduction', 'Income tax', tax, 'tax');
  }

  const earnings = round2(sum('earning'));
  const deductions = round2(sum('deduction'));
  let net = earnings - deductions;
  if (net < 0) warnings.push('Deductions are more than earnings: net pay set to 0.');
  net = Math.max(0, roundNet(net, settings.payroll_rounding));

  if (!gross && !components.length) warnings.push('No salary defined for this employee.');
  return {
    lines, warnings, earnings, deductions, net, taxableMonthly: round2(taxableMonthly), ...out, factor,
  };
}

module.exports = { computePayslip, annualTax, roundNet };
