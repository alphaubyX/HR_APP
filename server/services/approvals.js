'use strict';

/**
 * Approval chains for leave and attendance corrections.
 *
 * A request goes to the employee's line manager, then (if the organization asks for more levels)
 * to that manager's manager, and so on. A manager who has left, or is on leave that day, is skipped
 * and the request goes one level higher. If nobody is left, or the organization wants HR to sign
 * off last, HR gets it. A request that waits too long moves up a level on its own.
 */

const { utcNow } = require('../lib/dates');
const { managerMap, managersAbove, notifyEmployees, usersWithPerm, notifyUsers, fullName } = require('./common');

async function unavailableEmployees(db, orgId, ids, date) {
  if (!ids.length) return new Set();
  const inIds = ids.map(() => '?').join(',');
  const gone = await db.all(
    `SELECT id FROM employees WHERE org_id = ? AND id IN (${inIds}) AND (status IN ('exited', 'suspended') OR (exit_date IS NOT NULL AND exit_date < ?))`,
    [orgId, ...ids, date]);
  const away = await db.all(
    `SELECT employee_id AS id FROM leave_requests WHERE org_id = ? AND status = 'approved' AND half_day = 'none'
     AND from_date <= ? AND to_date >= ? AND employee_id IN (${inIds})`,
    [orgId, date, date, ...ids]);
  return new Set([...gone, ...away].map((r) => r.id));
}

/** Build the list of steps for a request by employeeId, judged on date (usually today). */
async function buildChain(db, org, employeeId, date) {
  const s = org.settings;
  const map = await managerMap(db, org.id);
  const above = managersAbove(map, employeeId);
  const unavailable = s.leave_skip_absent_approver ? await unavailableEmployees(db, org.id, above, date) : new Set();
  const names = new Map();
  if (above.length) {
    const rows = await db.all(`SELECT id, first_name, last_name FROM employees WHERE id IN (${above.map(() => '?').join(',')})`, above);
    rows.forEach((r) => names.set(r.id, fullName(r)));
  }
  const steps = [];
  const skipped = [];
  for (const id of above) {
    if (steps.length >= s.leave_approval_levels) break;
    if (unavailable.has(id)) { skipped.push({ id, name: names.get(id) }); continue; }
    steps.push({ type: 'employee', id, name: names.get(id) || 'Manager' });
  }
  if (!steps.length || s.leave_hr_final) steps.push({ type: 'hr', name: 'HR' });
  return { steps, skipped };
}

function parseChain(row) {
  if (Array.isArray(row.chain)) return row.chain;
  try { return JSON.parse(row.chain || '[]'); } catch { return []; }
}

/** May the signed-in person act on this request now? HR (with the permission) may always step in. */
function canAct(req, row, managePerm) {
  if (row.status !== 'pending') return false;
  if (req.perms.has(managePerm)) return true;
  const step = parseChain(row)[row.step];
  return !!step && step.type === 'employee' && step.id === req.member.employee_id;
}

async function notifyStep(db, org, row, subject, title) {
  const step = parseChain(row)[row.step];
  if (!step) return;
  const link = subject === 'leave' ? '#/leave/approvals' : '#/attendance/corrections';
  if (step.type === 'employee') {
    await notifyEmployees(db, org.id, [step.id], title, null, link);
  } else {
    const perm = subject === 'leave' ? 'leave.manage' : 'attendance.manage';
    const hr = await usersWithPerm(db, org.id, perm);
    await notifyUsers(db, org.id, hr.map((h) => h.user_id), title, null, link);
  }
}

async function recordAction(db, req, subject, row, action, comment = null) {
  await db.insert('approval_actions', {
    org_id: row.org_id, subject, subject_id: row.id, step: row.step, action, comment: comment ? String(comment).slice(0, 500) : null,
    user_id: req ? req.user.id : null, employee_id: req ? req.member.employee_id : null, created_at: utcNow(),
  });
}

/**
 * Approve or reject. Returns 'approved' (final), 'forwarded' (moved to the next step) or 'rejected'.
 * HR acting with the manage permission on someone else's step gives the final approval.
 */
async function decide(db, req, table, subject, row, approve, comment) {
  const chain = parseChain(row);
  const managePerm = subject === 'leave' ? 'leave.manage' : 'attendance.manage';
  const step = chain[row.step];
  const isOwnStep = step && step.type === 'employee' && step.id === req.member.employee_id;
  const now = utcNow();
  if (!approve) {
    await db.update(table, { id: row.id }, { status: 'rejected', decided_at: now, approver_employee_id: null });
    await recordAction(db, req, subject, row, 'rejected', comment);
    return 'rejected';
  }
  const hrOverride = !isOwnStep && req.perms.has(managePerm);
  if (!hrOverride && row.step < chain.length - 1) {
    const nextStep = row.step + 1;
    await recordAction(db, req, subject, row, 'approved', comment);
    const next = chain[nextStep];
    await db.update(table, { id: row.id }, {
      step: nextStep, step_since: now, approver_employee_id: next.type === 'employee' ? next.id : null,
    });
    return 'forwarded';
  }
  await recordAction(db, req, subject, row, hrOverride && step && step.type !== 'hr' ? 'approved_by_hr' : 'approved', comment);
  await db.update(table, { id: row.id }, { status: 'approved', decided_at: now, approver_employee_id: null });
  return 'approved';
}

/** Move requests that waited too long one step up (or to HR). Returns how many moved. */
async function escalate(db, org, table, subject) {
  const days = org.settings.leave_escalate_days;
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const rows = await db.all(`SELECT * FROM ${table} WHERE org_id = ? AND status = 'pending' AND step_since < ?`, [org.id, cutoff]);
  let moved = 0;
  for (const row of rows) {
    const chain = parseChain(row);
    const cur = chain[row.step];
    if (!cur || cur.type === 'hr') continue;
    let next = row.step + 1;
    if (next >= chain.length) { chain.push({ type: 'hr', name: 'HR' }); next = chain.length - 1; }
    await db.update(table, { id: row.id }, {
      chain: JSON.stringify(chain), step: next, step_since: utcNow(), approver_employee_id: chain[next].type === 'employee' ? chain[next].id : null,
    });
    await recordAction(db, null, subject, row, 'escalated', `No answer from ${cur.name} in ${days} day(s)`);
    await notifyStep(db, org, { ...row, chain: JSON.stringify(chain), step: next }, subject,
      `A ${subject === 'leave' ? 'leave request' : 'attendance correction'} was moved to you because it waited ${days} day(s)`);
    moved++;
  }
  return moved;
}

async function history(db, subject, id) {
  return db.all(
    `SELECT a.*, u.name AS user_name FROM approval_actions a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.subject = ? AND a.subject_id = ? ORDER BY a.id`, [subject, id]);
}

module.exports = { buildChain, parseChain, canAct, decide, escalate, notifyStep, recordAction, history };
