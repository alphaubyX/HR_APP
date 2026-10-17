'use strict';

const { seedRoles } = require('./roles');

/** A new organization starts with sensible defaults it can change under Settings. */

const { utcNow } = require('../lib/dates');
const { orgSettings } = require('../engine/policy');

const DEFAULT_COMPONENTS = [
  // gross = basic + 45% house rent + 10% utilities, so basic = gross / 1.55
  { name: 'Basic salary', code: 'BASIC', kind: 'earning', calc: 'formula', value: 0, formula: 'floor(GROSS / 1.55)' },
  { name: 'House rent', code: 'HOUSE_RENT', kind: 'earning', calc: 'percent', value: 45, percent_of: 'BASIC' },
  { name: 'Utilities', code: 'UTILITIES', kind: 'earning', calc: 'percent', value: 10, percent_of: 'BASIC' },
  { name: 'Fuel allowance', code: 'FUEL', kind: 'earning', calc: 'fixed', value: 0 },
  { name: 'Other allowance', code: 'OTHER', kind: 'earning', calc: 'remainder', value: 0 },
  { name: 'Provident fund', code: 'PF', kind: 'deduction', calc: 'percent', value: 0, percent_of: 'BASIC', active: 0, attendance_based: 0, taxable: 0 },
];

const DEFAULT_LEAVE_TYPES = [
  { name: 'Annual leave', code: 'AL', color: '#2563eb', annual_quota: 14, paid: 1, carry_forward_max: 7, allow_in_probation: 0 },
  { name: 'Casual leave', code: 'CL', color: '#16a34a', annual_quota: 10, paid: 1, carry_forward_max: 0, allow_in_probation: 1 },
  { name: 'Sick leave', code: 'SL', color: '#dc2626', annual_quota: 8, paid: 1, carry_forward_max: 0, allow_in_probation: 1 },
  { name: 'Unpaid leave', code: 'UL', color: '#64748b', annual_quota: 0, paid: 0, carry_forward_max: 0, allow_in_probation: 1, allow_negative: 1, prorate_on_join: 0 },
  { name: 'Maternity leave', code: 'ML', color: '#db2777', annual_quota: 90, paid: 1, carry_forward_max: 0, allow_in_probation: 1, gender: 'female', count_off_days: 1, prorate_on_join: 0 },
];

const DEFAULT_CHECKLIST = {
  onboarding: [
    'Offer letter signed', 'National ID copy collected', 'Bank account details collected',
    'Enrolled on the attendance machine', 'Sign-in account created', 'Laptop / equipment issued', 'Introduced to the team',
  ],
  exit: ['Resignation accepted', 'Equipment returned', 'Sign-in account disabled', 'Final settlement paid', 'Experience letter issued'],
};

async function seedOrg(db, orgId) {
  const now = utcNow();
  await db.insert('branches', { org_id: orgId, name: 'Head office', code: 'HO', radius_m: 150, created_at: now });
  await db.insert('departments', { org_id: orgId, name: 'Management', code: 'MGT', color: '#4f46e5', created_at: now });
  for (const [i, name] of ['Chief Executive', 'Manager', 'Team lead', 'Officer', 'Executive', 'Assistant'].entries()) {
    await db.insert('designations', { org_id: orgId, name, sort: i });
  }
  await db.insert('shifts', { org_id: orgId, name: 'General (9 to 6)', start_time: '09:00', end_time: '18:00', break_minutes: 60, weekly_off: '6,7', is_default: 1 });
  await db.insert('attendance_policies', { org_id: orgId, name: 'Standard', rules: JSON.stringify({}), is_default: 1 });

  const ids = {};
  for (const [i, c] of DEFAULT_COMPONENTS.entries()) {
    ids[c.code] = await db.insert('salary_components', {
      org_id: orgId, name: c.name, code: c.code, kind: c.kind, calc: c.calc, value: c.value, percent_of: c.percent_of || null, formula: c.formula || null,
      taxable: c.taxable ?? 1, attendance_based: c.attendance_based ?? 1, prorate: 1, show_on_payslip: 1, sort: i, active: c.active ?? 1,
    });
  }
  const sid = await db.insert('salary_structures', { org_id: orgId, name: 'Standard', description: 'Gross split into basic, house rent, utilities and allowances' });
  for (const [i, c] of DEFAULT_COMPONENTS.filter((x) => x.active !== 0).entries()) {
    await db.insert('structure_lines', {
      org_id: orgId, structure_id: sid, component_id: ids[c.code], calc: c.calc, value: c.value, percent_of: c.percent_of || null, formula: c.formula || null, sort: i,
    });
  }

  for (const [i, t] of DEFAULT_LEAVE_TYPES.entries()) {
    await db.insert('leave_types', {
      org_id: orgId, name: t.name, code: t.code, color: t.color, annual_quota: t.annual_quota, paid: t.paid,
      carry_forward_max: t.carry_forward_max, allow_half_day: 1, allow_in_probation: t.allow_in_probation,
      prorate_on_join: t.prorate_on_join ?? 1, count_off_days: t.count_off_days || 0, gender: t.gender || 'any',
      allow_negative: t.allow_negative || 0, sort: i,
    });
  }
  for (const [stage, items] of Object.entries(DEFAULT_CHECKLIST)) {
    for (const [i, title] of items.entries()) await db.insert('checklist_items', { org_id: orgId, stage, title, sort: i });
  }
}

/** Create an organization with its defaults; returns its id. */
async function createOrg(db, { name, code, currency = 'PKR', timezone = 'Asia/Karachi', country = null, plan = 'trial' }) {
  return db.tx(async (t) => {
    const id = await t.insert('orgs', {
      name, code, currency, timezone, country, plan, status: 'active', settings: JSON.stringify(orgSettings({})), created_at: utcNow(),
    });
    await seedOrg(t, id);
    await seedRoles(t, id);
    return id;
  });
}

module.exports = { createOrg, seedOrg, DEFAULT_COMPONENTS, DEFAULT_LEAVE_TYPES };
