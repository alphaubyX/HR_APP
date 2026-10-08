'use strict';

/** Loading punches, leave and holidays from the database and storing processed attendance days. */

const { addDays, eachDay, nowIn, utcNow, toMinutes } = require('../lib/dates');
const { shiftForDay, dayWindow, processDay, applyRangeRules } = require('../engine/attendance');
const { loadOrg, loadPolicies, loadShifts } = require('./common');

const DAY_COLUMNS = [
  'org_id', 'employee_id', 'work_date', 'status', 'shift_start', 'shift_end', 'first_in', 'last_out', 'punch_count',
  'worked_minutes', 'late_minutes', 'early_minutes', 'short_minutes', 'overtime_minutes', 'ot_rate', 'deduction_days',
  'leave_request_id', 'leave_paid', 'holiday_id', 'remarks', 'manual', 'manual_note', 'processed_at',
];

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Holidays for an employee's branch on a date: a branch-specific one wins over an all-branch one. */
function holidayFor(holidaysByDate, date, branchId) {
  const list = holidaysByDate.get(date);
  if (!list) return null;
  return list.find((h) => h.branch_id && h.branch_id === branchId) || list.find((h) => !h.branch_id) || null;
}

async function loadHolidays(db, orgId, from, to) {
  const rows = await db.all('SELECT * FROM holidays WHERE org_id = ? AND holiday_date >= ? AND holiday_date <= ?', [orgId, from, to]);
  const map = new Map();
  for (const h of rows) {
    if (!map.has(h.holiday_date)) map.set(h.holiday_date, []);
    map.get(h.holiday_date).push(h);
  }
  return map;
}

/**
 * Recalculate attendance for a date range. Days set by hand (manual = 1) are kept. Future days are
 * never processed. Returns the number of day records written.
 */
async function processRange(db, orgId, { from, to, employeeIds = null }) {
  const org = await loadOrg(db, orgId);
  const today = nowIn(org.timezone).date;
  if (to > today) to = today;
  if (from > to) return 0;

  let sql = 'SELECT * FROM employees WHERE org_id = ? AND join_date <= ? AND (exit_date IS NULL OR exit_date >= ?)';
  const params = [orgId, to, from];
  if (employeeIds) {
    if (!employeeIds.length) return 0;
    sql += ` AND id IN (${employeeIds.map(() => '?').join(',')})`;
    params.push(...employeeIds);
  }
  const employees = await db.all(sql, params);
  if (!employees.length) return 0;

  const [shifts, policies, holidays] = await Promise.all([
    loadShifts(db, orgId), loadPolicies(db, orgId), loadHolidays(db, orgId, from, to),
  ]);
  const dates = eachDay(from, to);
  let written = 0;

  for (const group of chunk(employees, 200)) {
    const ids = group.map((e) => e.id);
    const inIds = ids.map(() => '?').join(',');

    // Punches that arrived before the employee's machine number was set are linked now.
    for (const e of group) {
      if (e.device_user_id) {
        await db.run('UPDATE punches SET employee_id = ? WHERE org_id = ? AND employee_id IS NULL AND device_user_id = ?', [e.id, orgId, e.device_user_id]);
      }
    }

    const leaves = await db.all(
      `SELECT r.id, r.employee_id, r.from_date, r.to_date, r.half_day, t.paid, t.count_off_days
       FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
       WHERE r.org_id = ? AND r.status = 'approved' AND r.from_date <= ? AND r.to_date >= ? AND r.employee_id IN (${inIds})`,
      [orgId, to, from, ...ids]);
    const punches = await db.all(
      `SELECT employee_id, punch_time FROM punches WHERE org_id = ? AND employee_id IN (${inIds}) AND punch_time >= ? AND punch_time < ?
       ORDER BY punch_time`,
      [orgId, ...ids, `${addDays(from, -1)} 00:00:00`, `${addDays(to, 2)} 00:00:00`]);
    const manual = await db.all(
      `SELECT * FROM attendance_days WHERE org_id = ? AND manual = 1 AND work_date >= ? AND work_date <= ? AND employee_id IN (${inIds})`,
      [orgId, from, to, ...ids]);

    const leavesBy = new Map();
    for (const l of leaves) {
      if (!leavesBy.has(l.employee_id)) leavesBy.set(l.employee_id, []);
      leavesBy.get(l.employee_id).push(l);
    }
    const punchesBy = new Map();
    for (const p of punches) {
      if (!punchesBy.has(p.employee_id)) punchesBy.set(p.employee_id, []);
      punchesBy.get(p.employee_id).push(toMinutes(p.punch_time));
    }
    const manualBy = new Map(manual.map((m) => [`${m.employee_id}|${m.work_date}`, m]));

    const rows = [];
    const now = utcNow();
    for (const e of group) {
      const shift = (e.shift_id && shifts.byId.get(e.shift_id)) || shifts.default;
      const policy = (e.policy_id && policies.byId.get(e.policy_id)) || policies.default;
      const rules = policy.rules;
      const myPunches = punchesBy.get(e.id) || [];
      const myLeaves = leavesBy.get(e.id) || [];
      const days = [];
      for (const date of dates) {
        const m = manualBy.get(`${e.id}|${date}`);
        if (m) { days.push({ ...m, manual: 1 }); continue; }
        const shiftDay = shiftForDay(shift, date);
        const [a, b] = dayWindow(date, shiftDay.start);
        const l = myLeaves.find((x) => x.from_date <= date && x.to_date >= date);
        const rec = processDay({
          date,
          employee: e,
          shiftDay,
          rules,
          holiday: holidayFor(holidays, date, e.branch_id),
          leave: l ? { request_id: l.id, paid: !!Number(l.paid), half: l.half_day || 'none', count_off_days: !!Number(l.count_off_days) } : null,
          punches: myPunches.filter((x) => x >= a && x < b),
        });
        days.push(rec);
      }
      applyRangeRules(days, rules);
      for (const d of days) {
        if (d.manual) continue;
        rows.push({ ...d, org_id: orgId, employee_id: e.id, manual: 0, manual_note: null, processed_at: now });
      }
    }

    await db.tx(async (t) => {
      await t.run(
        `DELETE FROM attendance_days WHERE org_id = ? AND manual = 0 AND work_date >= ? AND work_date <= ? AND employee_id IN (${inIds})`,
        [orgId, from, to, ...ids]);
      for (const part of chunk(rows, 150)) {
        const placeholders = part.map(() => `(${DAY_COLUMNS.map(() => '?').join(',')})`).join(',');
        await t.run(`INSERT INTO attendance_days (${DAY_COLUMNS.join(',')}) VALUES ${placeholders}`,
          part.flatMap((r) => DAY_COLUMNS.map((c) => r[c] ?? null)));
      }
    });
    written += rows.length;
  }
  return written;
}

module.exports = { processRange, loadHolidays, holidayFor, DAY_COLUMNS };

/* ------------------------------------------------------------ punch intake */

// Employees whose attendance needs recalculating, from the earliest date that changed.
const dirty = new Map(); // orgId → Map(employeeId → earliest date)

function markDirty(orgId, employeeId, date) {
  if (!employeeId) return;
  if (!dirty.has(orgId)) dirty.set(orgId, new Map());
  const m = dirty.get(orgId);
  if (!m.has(employeeId) || date < m.get(employeeId)) m.set(employeeId, date);
}

/** Recalculate everything marked dirty (called every few seconds by the scheduler, and by tests). */
async function flushDirty(db) {
  for (const [orgId, m] of [...dirty]) {
    dirty.delete(orgId);
    const byDate = new Map();
    for (const [emp, date] of m) {
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(emp);
    }
    const org = await db.get('SELECT timezone FROM orgs WHERE id = ?', [orgId]);
    if (!org) continue;
    const today = nowIn(org.timezone).date;
    for (const [date, emps] of byDate) {
      // a punch just after midnight may belong to the night shift of the day before
      await processRange(db, orgId, { from: addDays(date, -1), to: today, employeeIds: emps });
    }
  }
}

/**
 * Store punches from a machine, an import or the phone app. Each item: { device_user_id | employee_id,
 * time: 'YYYY-MM-DD HH:MM[:SS]' (organization time), direction?, lat?, lng?, … }.
 * Duplicates (same person, same minute) are skipped. Returns counts.
 */
async function ingestPunches(db, orgId, items, { source, deviceId = null, userId = null } = {}) {
  const employees = await db.all('SELECT id, device_user_id FROM employees WHERE org_id = ? AND device_user_id IS NOT NULL', [orgId]);
  const byDeviceId = new Map(employees.map((e) => [String(e.device_user_id), e.id]));
  const result = { inserted: 0, duplicates: 0, unmatched: 0, invalid: 0 };
  const now = utcNow();
  for (const it of items) {
    const t = String(it.time || '').trim().replace('T', ' ');
    const m = t.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) { result.invalid++; continue; }
    const time = `${m[1]} ${m[2]}:${m[3]}:${m[4] || '00'}`;
    const devUser = it.device_user_id !== undefined && it.device_user_id !== null ? String(it.device_user_id).trim().slice(0, 30) : null;
    const employeeId = it.employee_id || (devUser ? byDeviceId.get(devUser) : null) || null;
    if (!employeeId && !devUser) { result.invalid++; continue; }
    const who = devUser ? `d${devUser}` : `e${employeeId}`;
    const id = await db.insertIgnore('punches', {
      org_id: orgId, employee_id: employeeId, device_user_id: devUser, punch_time: time,
      direction: ['in', 'out'].includes(it.direction) ? it.direction : 'auto', source, device_id: deviceId,
      lat: it.lat ?? null, lng: it.lng ?? null, accuracy_m: it.accuracy_m ?? null, branch_id: it.branch_id ?? null,
      distance_m: it.distance_m ?? null, note: it.note ? String(it.note).slice(0, 300) : null,
      dedupe_key: `${orgId}|${who}|${time.slice(0, 16)}`, user_id: userId, created_at: now,
    });
    if (!id) { result.duplicates++; continue; }
    result.inserted++;
    if (employeeId) markDirty(orgId, employeeId, time.slice(0, 10)); else result.unmatched++;
  }
  return result;
}

module.exports.markDirty = markDirty;
module.exports.flushDirty = flushDirty;
module.exports.ingestPunches = ingestPunches;
