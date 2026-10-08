'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, evaluate, compile } = require('../server/engine/formula');
const { computeComponents, checkFormula } = require('../server/engine/salary');
const { processDay, shiftForDay, summarize, applyRangeRules } = require('../server/engine/attendance');
const { computePayslip, annualTax } = require('../server/engine/payroll');
const { policyRules, orgSettings } = require('../server/engine/policy');
const { leaveYearOf, leaveYearRange, countLeaveDays, allocationFor } = require('../server/engine/leave');
const { payPeriod, toMinutes, nowIn } = require('../server/lib/dates');
const { distanceM, matchGeofence } = require('../server/lib/geo');

const run = (src, vars = {}) => evaluate(compile(src), (n) => { if (!(n in vars)) throw new Error(`unknown ${n}`); return vars[n]; });

test('formulas: arithmetic, precedence, functions, comparisons', () => {
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('-2 + 5'), 3);
  assert.equal(run('BASIC * 45 / 100', { BASIC: 1000 }), 450);
  assert.equal(run('min(GROSS * 0.1, 5000)', { GROSS: 100000 }), 5000);
  assert.equal(run('max(0, 10 - 20)'), 0);
  assert.equal(run('round(10 / 3, 2)'), 3.33);
  assert.equal(run('if(GROSS > 50000, 2500, 1500)', { GROSS: 60000 }), 2500);
  assert.equal(run('if(GROSS > 50000 && GROSS < 55000, 1, 0)', { GROSS: 60000 }), 0);
  assert.equal(run('10 / 0'), 0, 'division by zero is 0, not Infinity');
  assert.throws(() => parse('1 +'), /ends too early/);
  assert.throws(() => parse('alert(1)'), /Unknown function/);
  assert.throws(() => parse('a; b'), /Unexpected/);
  assert.throws(() => parse('process.exit()'), /Unexpected/);
});

test('salary components: percent, formula, remainder and errors', () => {
  const lines = [
    { code: 'BASIC', name: 'Basic', kind: 'earning', calc: 'formula', formula: 'floor(GROSS / 1.55)' },
    { code: 'HOUSE_RENT', name: 'House rent', kind: 'earning', calc: 'percent', value: 45, percent_of: 'BASIC' },
    { code: 'UTILITIES', name: 'Utilities', kind: 'earning', calc: 'percent', value: 10, percent_of: 'BASIC' },
    { code: 'OTHER', name: 'Other', kind: 'earning', calc: 'remainder' },
    { code: 'PF', name: 'PF', kind: 'deduction', calc: 'percent', value: 10, percent_of: 'BASIC' },
  ];
  const r = computeComponents(lines, { GROSS: 155000 });
  assert.equal(r.amounts.BASIC, 100000);
  assert.equal(r.amounts.HOUSE_RENT, 45000);
  assert.equal(r.amounts.UTILITIES, 10000);
  assert.equal(r.amounts.OTHER, 0);
  assert.equal(r.amounts.PF, 10000);
  assert.deepEqual(r.errors, []);
  const earn = r.lines.filter((l) => l.kind === 'earning').reduce((a, l) => a + l.amount, 0);
  assert.equal(earn, 155000, 'earnings add up to the gross');

  const loop = computeComponents([
    { code: 'A', name: 'A', kind: 'earning', calc: 'formula', formula: 'B + 1' },
    { code: 'B', name: 'B', kind: 'earning', calc: 'formula', formula: 'A + 1' },
  ], { GROSS: 0 });
  assert.ok(loop.errors.some((e) => /depends on itself/.test(e)));
  assert.equal(checkFormula('BASIC * 2', ['BASIC', 'GROSS']), null);
  assert.match(checkFormula('FOO * 2', ['BASIC', 'GROSS']), /Unknown name: FOO/);
});

const SHIFT = { start_time: '09:00', end_time: '18:00', break_minutes: 60, weekly_off: '6,7', day_overrides: null };
const EMP = { join_date: '2026-01-01', exit_date: null, attendance_required: 1 };
const day = (date, punches, extra = {}) => processDay({
  date, employee: EMP, shiftDay: shiftForDay(extra.shift || SHIFT, date), rules: policyRules(extra.rules || {}),
  holiday: extra.holiday || null, leave: extra.leave || null, punches: punches.map((t) => toMinutes(t.includes(' ') ? t : `${date} ${t}:00`)),
});

test('attendance: present, late, very late, absent, single punch', () => {
  // 2026-10-07 is a Wednesday
  let r = day('2026-10-07', ['08:55', '18:05']);
  assert.equal(r.status, 'present'); assert.equal(r.late_minutes, 0); assert.equal(r.worked_minutes, 550);
  r = day('2026-10-07', ['09:14', '18:00']);
  assert.equal(r.late_minutes, 0, 'inside 15 min grace');
  r = day('2026-10-07', ['09:20', '18:00']);
  assert.equal(r.status, 'present'); assert.equal(r.late_minutes, 20);
  r = day('2026-10-07', ['11:30', '18:00']);
  assert.equal(r.status, 'half_day'); assert.equal(r.deduction_days, 0.5);
  r = day('2026-10-07', []);
  assert.equal(r.status, 'absent'); assert.equal(r.deduction_days, 1);
  r = day('2026-10-07', ['09:00']);
  assert.equal(r.status, 'missing'); assert.equal(r.deduction_days, 0);
  r = day('2026-10-07', ['09:00', '11:00']);
  assert.equal(r.status, 'absent', 'less than 4 hours worked');
  r = day('2026-10-07', ['09:00', '09:01', '18:00']);
  assert.equal(r.punch_count, 2, 'punches a minute apart count once');
});

test('attendance: weekends, holidays, exceptional days, leave, overtime, night shift', () => {
  assert.equal(day('2026-10-10', []).status, 'weekend'); // Saturday
  const ot = day('2026-10-10', ['10:00', '14:00'], { rules: { overtime_enabled: true } });
  assert.equal(ot.overtime_minutes, 240); assert.equal(ot.ot_rate, 2);
  assert.equal(day('2026-10-07', [], { holiday: { id: 1, kind: 'public', treatment: 'closed', name: 'X' } }).status, 'holiday');
  const relaxed = day('2026-10-07', ['10:30', '18:00'], { holiday: { id: 2, kind: 'exceptional', treatment: 'relaxed', name: 'Rain' } });
  assert.equal(relaxed.status, 'present'); assert.equal(relaxed.late_minutes, 0);
  assert.equal(day('2026-10-07', [], { holiday: { id: 2, kind: 'exceptional', treatment: 'relaxed', name: 'Rain' } }).status, 'present', 'no absence on a relaxed day');
  const half = day('2026-10-07', ['09:00', '13:05'], { holiday: { id: 3, kind: 'exceptional', treatment: 'half_day', name: 'Half' } });
  assert.equal(half.status, 'present');
  const leave = day('2026-10-07', [], { leave: { request_id: 9, paid: true, half: 'none' } });
  assert.equal(leave.status, 'leave'); assert.equal(leave.deduction_days, 0);
  const unpaid = day('2026-10-07', [], { leave: { request_id: 9, paid: false, half: 'none' } });
  assert.equal(unpaid.deduction_days, 1);
  const halfLeave = day('2026-10-07', ['13:30', '18:00'], { leave: { request_id: 9, paid: true, half: 'first' } });
  assert.equal(halfLeave.status, 'half_leave'); assert.equal(halfLeave.late_minutes, 0);
  const otDay = day('2026-10-07', ['09:00', '19:30'], { rules: { overtime_enabled: true } });
  assert.equal(otDay.overtime_minutes, 90); assert.equal(otDay.ot_rate, 1.5);
  const night = { start_time: '22:00', end_time: '06:00', break_minutes: 0, weekly_off: '' };
  const n = day('2026-10-07', ['2026-10-07 22:05:00', '2026-10-08 06:02:00'], { shift: night });
  assert.equal(n.status, 'present'); assert.equal(n.worked_minutes, 477);
  const friday = { ...SHIFT, day_overrides: JSON.stringify({ 5: { start: '09:00', end: '13:00' } }) };
  assert.equal(shiftForDay(friday, '2026-10-09').end, '13:00');
});

test('attendance: monthly lates and the sandwich rule', () => {
  const rules = policyRules({ lates_per_deduction: 3, late_deduction_days: 1, sandwich_rule: true });
  const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((d) => day(d, ['09:30', '18:00']));
  assert.equal(summarize(days, rules).late_deduction_days, 1, '5 lates → one block of 3');
  const seq = [day('2026-10-09', []), day('2026-10-10', []), day('2026-10-11', []), day('2026-10-12', [])];
  applyRangeRules(seq, rules);
  assert.deepEqual(seq.map((d) => d.status), ['absent', 'absent', 'absent', 'absent'], 'weekend between Friday and Monday absences');
  const s = summarize(seq, rules);
  assert.equal(s.absent_days, 4);
});

test('payroll: proration, absences, lates from leave first, overtime, loan and tax', () => {
  const settings = orgSettings({ payroll_rounding: 'none' });
  const comps = [
    { code: 'BASIC', name: 'Basic', kind: 'earning', amount: 60000, taxable: true, attendance_based: true, prorate: true },
    { code: 'HR', name: 'House rent', kind: 'earning', amount: 30000, taxable: true, attendance_based: true, prorate: true },
    { code: 'FUEL', name: 'Fuel', kind: 'earning', amount: 10000, taxable: false, attendance_based: false, prorate: false },
  ];
  const base = { period: { start: '2026-09-01', end: '2026-09-30', days: 30 }, basisDays: 30, components: comps, gross: 100000, settings, slabs: [] };
  let r = computePayslip({ ...base, employedDays: 15, attendance: null, rules: policyRules({}) });
  assert.equal(r.earnings, 55000, 'basic and house rent halved, fuel not prorated');

  const att = { deduction_days: 2, absence_deduction_days: 2, late_count: 4, late_deduction_days: 1, missing_days: 0, ot_minutes: 120, ot_weighted_minutes: 180 };
  r = computePayslip({ ...base, employedDays: 30, attendance: att, rules: policyRules({ overtime_enabled: true }), shiftMinutes: 480 });
  // per day = 90000 / 30 = 3000
  assert.equal(r.lines.find((l) => l.source === 'attendance').amount, 6000);
  assert.equal(r.lines.find((l) => l.source === 'late').amount, 3000);
  assert.equal(r.lines.find((l) => l.source === 'overtime').amount, 1125, '3 weighted hours × 375/h');
  r = computePayslip({ ...base, employedDays: 30, attendance: att, rules: policyRules({ absent_deduct_from: 'leave_then_salary', late_deduct_from: 'leave_then_salary' }), leaveAvailable: 2.5 });
  assert.equal(r.leaveAdjusted, 2.5);
  assert.equal(r.unpaidDays, 0.5);

  const slabs = [{ from_amount: 0, to_amount: 600000, fixed_tax: 0, rate: 0 }, { from_amount: 600000, to_amount: 1200000, fixed_tax: 0, rate: 5 }, { from_amount: 1200000, to_amount: null, fixed_tax: 30000, rate: 15 }];
  assert.equal(annualTax(500000, slabs), 0);
  assert.equal(annualTax(1000000, slabs), 20000);
  assert.equal(annualTax(1300000, slabs), 45000);
  r = computePayslip({ ...base, employedDays: 30, attendance: null, rules: policyRules({}), slabs, loans: [{ id: 1, kind: 'loan', installment: 5000, balance: 3000 }] });
  // taxable monthly 90000 → 1,080,000/yr → 24,000/yr → 2,000/month
  assert.equal(r.lines.find((l) => l.source === 'tax').amount, 2000);
  assert.equal(r.lines.find((l) => l.source === 'loan').amount, 3000, 'never more than the balance');
  assert.equal(r.net, 100000 - 2000 - 3000);
});

test('leave: years, allocation and day counting', () => {
  assert.equal(leaveYearOf('2026-03-01', 1), 2026);
  assert.equal(leaveYearOf('2026-03-01', 7), 2025);
  assert.deepEqual(leaveYearRange(2025, 7), { start: '2025-07-01', end: '2026-06-30' });
  assert.equal(allocationFor({ annual_quota: 14, prorate_on_join: 1 }, '2025-06-01', 2026), 14);
  assert.equal(allocationFor({ annual_quota: 12, prorate_on_join: 1 }, '2026-07-01', 2026), 6);
  assert.equal(allocationFor({ annual_quota: 12, prorate_on_join: 0 }, '2026-07-01', 2026), 12);
  // Thu 8 Oct → Tue 13 Oct: Thu, Fri, Mon, Tue = 4 working days
  assert.equal(countLeaveDays({ from: '2026-10-08', to: '2026-10-13', shift: SHIFT }), 4);
  assert.equal(countLeaveDays({ from: '2026-10-08', to: '2026-10-13', shift: SHIFT, countOffDays: true }), 6);
  assert.equal(countLeaveDays({ from: '2026-10-08', to: '2026-10-13', shift: SHIFT, holidayDates: new Set(['2026-10-12']) }), 3);
  assert.equal(countLeaveDays({ from: '2026-10-08', to: '2026-10-08', half: 'first' }), 0.5);
});

test('dates, periods and geofences', () => {
  assert.deepEqual(payPeriod('2026-10', 1), { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(payPeriod('2026-10', 26), { start: '2026-09-26', end: '2026-10-25' });
  assert.deepEqual(payPeriod('2026-03', 30), { start: '2026-02-28', end: '2026-03-29' });
  assert.match(nowIn('Asia/Karachi').datetime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const d = distanceM(31.5204, 74.3587, 31.5204, 74.3597);
  assert.ok(d > 90 && d < 100, `~95 m, got ${d}`);
  const fences = [{ id: 1, name: 'HO', lat: 31.5204, lng: 74.3587, radius_m: 150 }, { id: 2, name: 'WH', lat: 31.4697, lng: 74.3216, radius_m: 300 }];
  assert.equal(matchGeofence(31.5205, 74.3590, fences).inside, true);
  const far = matchGeofence(31.40, 74.20, fences);
  assert.equal(far.inside, false);
  assert.equal(far.nearest.branch.name, 'WH');
});
