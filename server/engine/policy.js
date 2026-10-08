'use strict';

/**
 * Attendance policy rules and organization settings, with their defaults. Policies are stored as
 * JSON so an organization can have several (office staff, field staff, factory …) and new rules can
 * be added without changing the database.
 */

const POLICY_RULES = {
  grace_minutes: { type: 'int', min: 0, max: 240, default: 15, label: 'Grace time after shift start (minutes)' },
  half_day_if_late_minutes: { type: 'int', min: 0, max: 720, default: 120, label: 'Arriving this late counts as a half day (minutes, 0 = never)' },
  lates_per_deduction: { type: 'int', min: 0, max: 31, default: 3, label: 'Every N late arrivals in a month …' },
  late_deduction_days: { type: 'num', min: 0, max: 5, default: 1, label: '… deduct this many days (0 = no deduction)' },
  late_deduct_from: { type: 'enum', values: ['salary', 'leave_then_salary'], default: 'salary', label: 'Late deductions come from' },
  early_grace_minutes: { type: 'int', min: 0, max: 240, default: 10, label: 'Grace time before shift end (minutes)' },
  count_early_as_late: { type: 'bool', default: true, label: 'Leaving early counts like a late arrival' },
  full_day_tolerance_minutes: { type: 'int', min: 0, max: 600, default: 60, label: 'Total time worked may be short by (minutes)' },
  short_time_action: { type: 'enum', values: ['none', 'half_day', 'hourly'], default: 'none', label: 'When it is shorter than that (on top of late marks)' },
  min_minutes_for_half_day: { type: 'int', min: 0, max: 900, default: 240, label: 'Less than this many minutes worked counts as absent' },
  single_punch: { type: 'enum', values: ['missing', 'half_day', 'present', 'absent'], default: 'missing', label: 'Only one punch in a day' },
  absent_deduction_days: { type: 'num', min: 0, max: 5, default: 1, label: 'Days deducted for each absence without leave' },
  absent_deduct_from: { type: 'enum', values: ['salary', 'leave_then_salary'], default: 'salary', label: 'Absences come from' },
  sandwich_rule: { type: 'bool', default: false, label: 'A weekend or holiday between two absences counts as absent' },
  overtime_enabled: { type: 'bool', default: false, label: 'Pay overtime' },
  overtime_min_minutes: { type: 'int', min: 0, max: 600, default: 30, label: 'Overtime counts after this many extra minutes' },
  overtime_rate: { type: 'num', min: 0, max: 10, default: 1.5, label: 'Overtime rate on working days (× hourly pay)' },
  overtime_offday_rate: { type: 'num', min: 0, max: 10, default: 2, label: 'Overtime rate on weekends and holidays (× hourly pay)' },
  overtime_max_hours_month: { type: 'num', min: 0, max: 400, default: 0, label: 'Most overtime hours paid per month (0 = no limit)' },
};

const ORG_SETTINGS = {
  probation_days: { type: 'int', min: 0, max: 730, default: 90, label: 'Default probation period (days)' },
  leave_year_start_month: { type: 'int', min: 1, max: 12, default: 1, label: 'Leave year starts in month (1 = January)' },
  leave_approval_levels: { type: 'int', min: 1, max: 4, default: 1, label: 'Approval levels (1 = line manager only, 2 = and their manager …)' },
  leave_hr_final: { type: 'bool', default: false, label: 'HR gives the final approval after the managers' },
  leave_escalate_days: { type: 'int', min: 0, max: 30, default: 2, label: 'Move a request up a level when it waits this many days (0 = never)' },
  leave_skip_absent_approver: { type: 'bool', default: true, label: 'Skip a manager who is on leave or has left' },
  payroll_day_basis: { type: 'enum', values: ['calendar', 'fixed30', 'working'], default: 'calendar', label: 'Daily rate = monthly salary divided by' },
  payroll_period_start_day: { type: 'int', min: 1, max: 28, default: 1, label: 'Payroll period starts on day (1 = calendar month)' },
  payroll_rounding: { type: 'enum', values: ['none', 'unit', 'ten'], default: 'unit', label: 'Round net pay to' },
  deduction_leave_code: { type: 'str', max: 20, default: 'AL', label: 'Leave type used when absences or lates come from leave (code)' },
  tax_enabled: { type: 'bool', default: true, label: 'Deduct income tax using the tax slabs' },
  mobile_accuracy_m: { type: 'int', min: 10, max: 5000, default: 100, label: 'Most GPS inaccuracy accepted for mobile attendance (metres)' },
  mobile_require_note_anywhere: { type: 'bool', default: false, label: 'Ask for a note when marking attendance outside a geofence' },
  employee_code_prefix: { type: 'str', max: 10, default: 'EMP-', label: 'Employee number prefix' },
};

function cleanValue(def, v) {
  switch (def.type) {
    case 'int': { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(def.max, Math.max(def.min, n)) : def.default; }
    case 'num': { const n = Number(v); return Number.isFinite(n) ? Math.min(def.max, Math.max(def.min, n)) : def.default; }
    case 'bool': return v === true || v === 1 || v === '1' || v === 'true';
    case 'enum': return def.values.includes(v) ? v : def.default;
    case 'str': return typeof v === 'string' ? v.slice(0, def.max) : def.default;
    default: return def.default;
  }
}

/** Merge stored values over the defaults, dropping unknown keys and clamping bad values. */
function withDefaults(defs, stored) {
  let obj = stored;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { obj = {}; } }
  obj = obj || {};
  const out = {};
  for (const [k, def] of Object.entries(defs)) out[k] = k in obj ? cleanValue(def, obj[k]) : def.default;
  return out;
}

const policyRules = (stored) => withDefaults(POLICY_RULES, stored);
const orgSettings = (stored) => withDefaults(ORG_SETTINGS, stored);

module.exports = { POLICY_RULES, ORG_SETTINGS, policyRules, orgSettings, withDefaults };
