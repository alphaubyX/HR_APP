'use strict';

/**
 * Background work, run inside the app (no cron needed on shared hosting):
 *  - every few seconds: recalculate attendance after new punches
 *  - every 15 minutes: process yesterday and today, make sure the leave year's allocations exist
 *    (this is what resets leave on 1 January), move stale approvals up, and remind HR about
 *    probation periods that are ending.
 * Each daily task remembers when it last ran in the jobs table, so restarts don't repeat it.
 */

const { nowIn, addDays, utcNow } = require('./lib/dates');
const { flushDirty, processRange } = require('./services/attendance');
const { ensureAllocations } = require('./services/leave');
const { escalate } = require('./services/approvals');
const { loadOrg, usersWithPerm, notifyUsers, fullName } = require('./services/common');
const { leaveYearOf } = require('./engine/leave');

async function onceA(db, name, key, fn) {
  const row = await db.get('SELECT * FROM jobs WHERE name = ?', [name]);
  if (row && row.last_run_key === key) return false;
  await fn();
  if (row) await db.update('jobs', { id: row.id }, { last_run_key: key, last_run_at: utcNow() });
  else await db.insert('jobs', { name, last_run_key: key, last_run_at: utcNow() });
  return true;
}

async function periodic(db) {
  const orgs = await db.all("SELECT id FROM orgs WHERE status = 'active'");
  for (const { id } of orgs) {
    try {
      const org = await loadOrg(db, id);
      const today = nowIn(org.timezone).date;
      const year = leaveYearOf(today, org.settings.leave_year_start_month);
      await ensureAllocations(db, org, year);
      await processRange(db, org.id, { from: addDays(today, -1), to: today });
      await escalate(db, org, 'leave_requests', 'leave');
      await escalate(db, org, 'regularizations', 'regularization');
      await onceA(db, `probation-reminders:${org.id}`, today, async () => {
        const due = await db.all("SELECT * FROM employees WHERE org_id = ? AND status = 'probation' AND probation_end IN (?, ?, ?)",
          [org.id, addDays(today, 7), addDays(today, 1), today]);
        if (!due.length) return;
        const hr = await usersWithPerm(db, org.id, 'employees.edit');
        for (const e of due) {
          await notifyUsers(db, org.id, hr.map((h) => h.user_id), `${fullName(e)}'s probation ends on ${e.probation_end}`,
            'Confirm them as permanent or extend the probation.', `#/employees/${e.id}`);
        }
      });
    } catch (err) {
      console.error(`Background task for organization ${id} failed:`, err.message);
    }
  }
  // old sessions and read notifications
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [utcNow()]);
}

function startScheduler(db) {
  let busy = false;
  const fast = setInterval(() => { flushDirty(db).catch((e) => console.error('Attendance update failed:', e.message)); }, 5000);
  const slow = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await periodic(db); } finally { busy = false; }
  }, 15 * 60000);
  setTimeout(() => periodic(db).catch((e) => console.error(e)), 10000);
  fast.unref(); slow.unref();
  return () => { clearInterval(fast); clearInterval(slow); };
}

module.exports = { startScheduler, periodic };
