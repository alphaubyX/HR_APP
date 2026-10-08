'use strict';

/**
 * Leave balances live in a ledger: every allocation, carry-forward, leave taken, cancellation and
 * manual adjustment is a row with + or − days. A balance is the sum of its rows for the leave year.
 * At the start of each leave year (1 January by default) every employee gets a fresh allocation,
 * and what is left of last year is carried forward up to the leave type's limit; the rest lapses.
 */

const { utcNow } = require('../lib/dates');
const { leaveYearRange, allocationFor } = require('../engine/leave');

const running = new Map(); // one allocation pass per organization and year at a time

async function ensureAllocations(db, org, year) {
  const key = `${org.id}|${year}`;
  if (running.has(key)) return running.get(key);
  const p = doEnsure(db, org, year).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

async function doEnsure(db, org, year) {
  const sm = org.settings.leave_year_start_month;
  const { start, end } = leaveYearRange(year, sm);
  const employees = await db.all(
    `SELECT id, join_date, gender, exit_date, status FROM employees
     WHERE org_id = ? AND join_date <= ? AND (exit_date IS NULL OR exit_date >= ?) AND status <> 'exited'`,
    [org.id, end, start]);
  const types = await db.all('SELECT * FROM leave_types WHERE org_id = ? AND active = 1 AND annual_quota > 0', [org.id]);
  if (!employees.length || !types.length) return 0;
  const done = new Set((await db.all(
    "SELECT employee_id, leave_type_id FROM leave_ledger WHERE org_id = ? AND leave_year = ? AND entry = 'allocation'",
    [org.id, year])).map((r) => `${r.employee_id}|${r.leave_type_id}`));
  const prev = new Map((await db.all(
    'SELECT employee_id, leave_type_id, SUM(days) AS bal, COUNT(*) AS n FROM leave_ledger WHERE org_id = ? AND leave_year = ? GROUP BY employee_id, leave_type_id',
    [org.id, year - 1])).map((r) => [`${r.employee_id}|${r.leave_type_id}`, Number(r.bal) || 0]));

  let created = 0;
  const now = utcNow();
  await db.tx(async (t) => {
    for (const e of employees) {
      for (const type of types) {
        if (type.gender !== 'any' && e.gender && e.gender !== type.gender) continue;
        const key = `${e.id}|${type.id}`;
        if (done.has(key)) continue;
        const days = allocationFor(type, e.join_date, year, sm);
        await t.insert('leave_ledger', {
          org_id: org.id, employee_id: e.id, leave_type_id: type.id, leave_year: year, entry: 'allocation', days,
          note: days < Number(type.annual_quota) ? 'Prorated from the joining date' : 'Yearly allocation', created_at: now,
        });
        if (prev.has(key)) {
          const bal = prev.get(key);
          const carry = Math.max(0, Math.min(bal, Number(type.carry_forward_max) || 0));
          if (carry > 0) {
            await t.insert('leave_ledger', { org_id: org.id, employee_id: e.id, leave_type_id: type.id, leave_year: year, entry: 'carry_forward', days: carry, note: `Carried forward from ${year - 1}`, created_at: now });
          }
          const lapse = bal - carry;
          if (lapse > 0) {
            await t.insert('leave_ledger', { org_id: org.id, employee_id: e.id, leave_type_id: type.id, leave_year: year - 1, entry: 'lapse', days: -lapse, note: 'Not carried forward: lapsed at year end', created_at: now });
          }
        }
        created++;
      }
    }
  });
  return created;
}

/** Balances of one employee for a leave year, one row per leave type that applies to them. */
async function balances(db, org, employee, year) {
  await ensureAllocations(db, org, year);
  const types = await db.all('SELECT * FROM leave_types WHERE org_id = ? AND active = 1 ORDER BY sort, name', [org.id]);
  const sums = await db.all(
    'SELECT leave_type_id, entry, SUM(days) AS days FROM leave_ledger WHERE org_id = ? AND employee_id = ? AND leave_year = ? GROUP BY leave_type_id, entry',
    [org.id, employee.id, year]);
  const { start, end } = leaveYearRange(year, org.settings.leave_year_start_month);
  const pending = await db.all(
    "SELECT leave_type_id, SUM(days) AS days FROM leave_requests WHERE org_id = ? AND employee_id = ? AND status = 'pending' AND from_date >= ? AND from_date <= ? GROUP BY leave_type_id",
    [org.id, employee.id, start, end]);
  const pend = new Map(pending.map((p) => [p.leave_type_id, Number(p.days) || 0]));
  return types
    .filter((t) => t.gender === 'any' || !employee.gender || t.gender === employee.gender)
    .map((t) => {
      const rows = sums.filter((s) => s.leave_type_id === t.id);
      const get = (...entries) => rows.filter((r) => entries.includes(r.entry)).reduce((a, r) => a + Number(r.days), 0);
      const balance = rows.reduce((a, r) => a + Number(r.days), 0);
      const pendingDays = pend.get(t.id) || 0;
      return {
        leave_type_id: t.id, name: t.name, code: t.code, color: t.color, paid: t.paid, allow_negative: t.allow_negative,
        allow_half_day: t.allow_half_day, unlimited: !Number(t.annual_quota) && !!t.allow_negative,
        allocated: get('allocation'), carried: get('carry_forward'), taken: -get('taken', 'cancelled'), adjusted: get('adjustment', 'payroll'),
        lapsed: -get('lapse'), balance: round(balance), pending: pendingDays, available: round(balance - pendingDays),
      };
    });
}

const round = (n) => Math.round(n * 100) / 100;

module.exports = { ensureAllocations, balances };
