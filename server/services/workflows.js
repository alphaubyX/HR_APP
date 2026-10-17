'use strict';

/**
 * Approval workflows: Action → Initiator → Approver 1 → Approver 2 …
 *
 * An organization switches a workflow on for an action (e.g. adding an employee). From then on,
 * when someone does that action, the app doesn't do it straight away: it keeps the request (the
 * API call and its data) and asks each approver in turn. When the last one approves, the request
 * is carried out exactly as the initiator sent it, in the initiator's name.
 */

const http = require('node:http');
const { bad, forbidden, notFound } = require('../lib/validate');
const { utcNow } = require('../lib/dates');
const { notifyUsers, fullName, audit } = require('./common');

/** Marks a request the app makes to itself to carry out an approved action. */
const INTERNAL = Symbol('internal call');

const id = (m, i = 1) => Number(m[i]);
/**
 * What can need approval. path is matched against the API path (after /api); perm is the right the
 * initiator must have; employee(match, body) says who it is about.
 */
const ACTIONS = [
  { key: 'employee.create', group: 'People', label: 'Add a new employee', method: 'POST', path: /^\/employees$/, perm: 'employees.edit' },
  { key: 'employee.update', group: 'People', label: 'Change an employee’s details or job', method: 'PUT', path: /^\/employees\/(\d+)$/, perm: 'employees.edit', employee: id },
  { key: 'employee.confirm', group: 'People', label: 'Confirm after probation', method: 'POST', path: /^\/employees\/(\d+)\/confirm$/, perm: 'employees.edit', employee: id },
  { key: 'employee.extend', group: 'People', label: 'Extend probation', method: 'POST', path: /^\/employees\/(\d+)\/extend-probation$/, perm: 'employees.edit', employee: id },
  { key: 'employee.exit', group: 'People', label: 'Exit, resignation or termination', method: 'POST', path: /^\/employees\/(\d+)\/exit$/, perm: 'employees.edit', employee: id },
  { key: 'employee.rehire', group: 'People', label: 'Rehire a former employee', method: 'POST', path: /^\/employees\/(\d+)\/rehire$/, perm: 'employees.edit', employee: id },
  { key: 'employee.delete', group: 'People', label: 'Delete an employee record', method: 'DELETE', path: /^\/employees\/(\d+)$/, perm: 'employees.edit', employee: id },
  { key: 'salary.revise', group: 'Pay', label: 'Salary revision', method: 'POST', path: /^\/employees\/(\d+)\/salary$/, perm: 'salary.edit', employee: id },
  { key: 'salary.bulk', group: 'Pay', label: 'Salary revision for many people', method: 'POST', path: /^\/salary\/bulk-revision$/, perm: 'salary.edit' },
  { key: 'loan.create', group: 'Pay', label: 'New loan or advance', method: 'POST', path: /^\/loans$/, perm: 'salary.edit', employee: (m, b) => b.employee_id },
  { key: 'adjustment.create', group: 'Pay', label: 'Bonus, allowance or deduction', method: 'POST', path: /^\/adjustments$/, perm: 'salary.edit', employee: (m, b) => b.employee_id },
  { key: 'payroll.approve', group: 'Pay', label: 'Approve a payroll month', method: 'POST', path: /^\/payroll\/runs\/(\d+)\/approve$/, perm: 'payroll.approve' },
  { key: 'attendance.correct', group: 'Relaxations', label: 'Correct or relax someone’s attendance day (e.g. waive a late)', method: 'PUT', path: /^\/attendance\/days\/(\d+)\/([\d-]+)$/, perm: 'attendance.manage', employee: id },
  { key: 'leave.adjust', group: 'Relaxations', label: 'Add or take away leave days by hand', method: 'POST', path: /^\/leave\/ledger$/, perm: 'leave.manage', employee: (m, b) => b.employee_id },
  { key: 'holiday.create', group: 'Relaxations', label: 'New holiday or exceptional day (e.g. rain day)', method: 'POST', path: /^\/holidays$/, perm: 'org.manage' },
  { key: 'policy.change', group: 'Relaxations', label: 'Change an attendance policy (late, short time, deductions)', method: 'PUT', path: /^\/policies\/(\d+)$/, perm: 'org.manage' },
];

/** Calls the initiator may attach to a pending request, run after it with {id} = the new record. */
const FOLLOWUPS = [/^\/employees\/\{id\}\/salary$/, /^\/employees\/\{id\}\/geofences$/, /^\/employees\/\{id\}\/account$/];

const STEP_TYPES = {
  role: 'Everyone with a role',
  user: 'A named person',
  initiator_manager: 'Line manager of the person who starts it',
  employee_manager: 'Line manager of the employee it is about',
  department_head: 'Head of the employee’s department',
};

function matchAction(method, path) {
  for (const a of ACTIONS) {
    if (a.method !== method) continue;
    const m = path.match(a.path);
    if (m) return { action: a, match: m };
  }
  return null;
}

const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

function cleanSteps(list) {
  if (!Array.isArray(list)) throw bad('Steps must be a list.');
  if (list.length > 10) throw bad('At most 10 approval steps.');
  return list.map((s) => {
    if (!s || !STEP_TYPES[s.type]) throw bad('Each step needs a type.');
    const out = { type: s.type };
    if (s.type === 'role') { if (!s.role_key) throw bad('Choose the role for each role step.'); out.role_key = String(s.role_key).slice(0, 20); }
    if (s.type === 'user') { if (!Number(s.user_id)) throw bad('Choose the person for each person step.'); out.user_id = Number(s.user_id); }
    return out;
  });
}

/* ------------------------------------------------------------------ who approves */

async function userOfEmployee(db, orgId, employeeId) {
  if (!employeeId) return null;
  const m = await db.get('SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.employee_id = ? AND m.active = 1 AND u.active = 1', [orgId, employeeId]);
  return m ? m.user_id : null;
}

/** One step of a workflow → its label and the user ids who can approve it. */
async function resolveStep(db, orgId, step, { initiator, employeeId, body }) {
  const name = async (empId) => { const e = empId && await db.get('SELECT first_name, last_name FROM employees WHERE id = ? AND org_id = ?', [empId, orgId]); return e ? fullName(e) : null; };
  let label = STEP_TYPES[step.type];
  let users = [];
  if (step.type === 'role') {
    const role = await db.get('SELECT name FROM roles WHERE org_id = ? AND role_key = ?', [orgId, step.role_key]);
    label = role ? role.name : step.role_key;
    users = (await db.all('SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = ? AND m.active = 1 AND u.active = 1', [orgId, step.role_key])).map((r) => r.user_id);
  } else if (step.type === 'user') {
    const u = await db.get('SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ? AND m.active = 1 AND u.active = 1', [orgId, step.user_id]);
    label = u ? u.name : 'A person who no longer has access';
    users = u ? [u.id] : [];
  } else {
    let empId = null;
    if (step.type === 'initiator_manager') {
      const me = await db.get('SELECT e.manager_id FROM memberships m JOIN employees e ON e.id = m.employee_id WHERE m.org_id = ? AND m.user_id = ?', [orgId, initiator]);
      empId = me && me.manager_id;
      label = 'Initiator’s line manager';
    } else if (step.type === 'employee_manager') {
      const e = employeeId && await db.get('SELECT manager_id FROM employees WHERE id = ? AND org_id = ?', [employeeId, orgId]);
      empId = e ? e.manager_id : body && body.manager_id ? Number(body.manager_id) : null;
      label = 'Employee’s line manager';
    } else if (step.type === 'department_head') {
      const e = employeeId && await db.get('SELECT department_id FROM employees WHERE id = ? AND org_id = ?', [employeeId, orgId]);
      const deptId = e ? e.department_id : body && body.department_id ? Number(body.department_id) : null;
      const d = deptId && await db.get('SELECT head_employee_id FROM departments WHERE id = ? AND org_id = ?', [deptId, orgId]);
      empId = d && d.head_employee_id;
      label = 'Head of department';
    }
    const who = await name(empId);
    if (who) label = `${label} (${who})`;
    const u = await userOfEmployee(db, orgId, empId);
    users = u ? [u] : [];
  }
  let note = null;
  if (!users.length) {
    // nobody holds that role or post (yet): the administrators decide instead, so a gap in the
    // set-up never lets an action through unapproved
    const { rolesWithPerm } = require('./roles');
    const keys = await rolesWithPerm(db, orgId, 'workflows.manage');
    users = (await db.all(`SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.active = 1 AND u.active = 1 AND m.role IN (${keys.map(() => '?').join(',')})`, [orgId, ...keys])).map((r) => r.user_id);
    note = `Nobody is ${label}, so an administrator decides`;
    label = `${label} → administrators`;
  }
  // nobody approves their own request
  users = [...new Set(users)].filter((u) => u !== initiator);
  if (!users.length) note = 'Only the initiator could approve this step: skipped';
  return { label, type: step.type, approvers: users, status: users.length ? 'waiting' : 'skipped', note };
}

/* ------------------------------------------------------------------ carrying out */

/** Make an API call inside the app as a given user, without going over the network. */
function runCall(app, { userId, orgId, method, path, body }) {
  return new Promise((resolve) => {
    const socket = { remoteAddress: '127.0.0.1', encrypted: false, on() {}, once() {}, removeListener() {}, destroy() {} };
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = `/api${path}`;
    req.headers = { 'content-type': 'application/json', 'user-agent': 'approval-workflow' };
    req.body = body || {};
    req._body = true; // already parsed: the JSON reader leaves it alone
    req[INTERNAL] = { userId, orgId };
    req.push(null);
    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (c) => { if (c && typeof c !== 'function') chunks.push(Buffer.from(c)); return true; };
    res.end = (c) => {
      if (c && typeof c !== 'function') chunks.push(Buffer.from(c));
      const text = Buffer.concat(chunks).toString();
      let data = null;
      try { data = JSON.parse(text); } catch { data = text; }
      resolve({ status: res.statusCode, data });
      return res;
    };
    app.handle(req, res, () => resolve({ status: 404, data: { error: 'Not found' } }));
  });
}

async function carryOut(ctx, row) {
  const { db } = ctx;
  const body = parse(row.body, {});
  const main = await runCall(ctx.app, { userId: row.initiator_user_id, orgId: row.org_id, method: row.method, path: row.path, body });
  if (main.status >= 400) {
    const error = (main.data && main.data.error) || `Failed (${main.status})`;
    await db.update('approval_requests', { id: row.id }, { status: 'failed', error: error.slice(0, 500), decided_at: utcNow() });
    return { ok: false, error };
  }
  const notes = [];
  const newId = main.data && main.data.id;
  for (const f of parse(row.followups, [])) {
    if (!newId) break;
    const r = await runCall(ctx.app, { userId: row.initiator_user_id, orgId: row.org_id, method: f.method, path: f.path.replace('{id}', newId), body: f.body });
    if (r.status >= 400) notes.push(`${f.label || f.path}: ${(r.data && r.data.error) || r.status}`);
  }
  await db.update('approval_requests', { id: row.id }, {
    status: 'approved', result: JSON.stringify(main.data).slice(0, 5000), error: notes.length ? notes.join(' · ').slice(0, 500) : null, decided_at: utcNow(),
  });
  return { ok: true, result: main.data, notes };
}

/* ------------------------------------------------------------------ starting a request */

async function describe(db, orgId, action, employeeId, body) {
  let who = null;
  if (employeeId) {
    const e = await db.get('SELECT first_name, last_name, emp_code FROM employees WHERE id = ? AND org_id = ?', [employeeId, orgId]);
    if (e) who = `${fullName(e)} (${e.emp_code})`;
  }
  if (action.key === 'employee.create') who = [body.first_name, body.last_name].filter(Boolean).join(' ') || 'new employee';
  if (action.key === 'holiday.create') who = [body.name, body.holiday_date].filter(Boolean).join(', ');
  return `${action.label}${who ? `: ${who}` : ''}`.slice(0, 250);
}

/**
 * Express middleware, before the API routes: if the call is an action with a workflow switched
 * on, keep it as a request for approval and answer 202 instead of doing it.
 */
function gate(ctx) {
  const { db } = ctx;
  return async (req, res, next) => {
    if (req[INTERNAL] || !req.org || req.method === 'GET') return next();
    const found = matchAction(req.method, req.path);
    if (!found) return next();
    const { action, match } = found;
    const wf = await db.get('SELECT * FROM workflows WHERE org_id = ? AND action = ? AND active = 1', [req.org.id, action.key]);
    if (!wf) return next();
    if (!req.perms.has(action.perm)) return next(forbidden());
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const employeeId = action.employee ? Number(action.employee(match, body)) || null : null;
    const steps = [];
    for (const s of parse(wf.steps, [])) steps.push(await resolveStep(db, req.org.id, s, { initiator: req.user.id, employeeId, body }));
    const first = steps.findIndex((s) => s.status === 'waiting');
    if (first < 0) return next(); // nobody else to ask: just do it
    const title = await describe(db, req.org.id, action, employeeId, body);
    const reqId = await db.insert('approval_requests', {
      org_id: req.org.id, workflow_id: wf.id, action: action.key, title, method: req.method, path: req.path,
      body: JSON.stringify(body), initiator_user_id: req.user.id, employee_id: employeeId, steps: JSON.stringify(steps), step: first,
      status: 'pending', created_at: utcNow(),
    });
    await notifyUsers(db, req.org.id, steps[first].approvers, `Waiting for your approval: ${title}`, `From ${req.user.name}`, '#/approvals');
    await audit(db, req, 'approval.request', 'approval_requests', reqId, { action: action.key });
    res.status(202).json({
      pending: true, approval_id: reqId,
      message: `Sent for approval to ${steps[first].label}. It happens once ${steps.filter((s) => s.status === 'waiting').length > 1 ? 'everyone in the chain approves' : 'they approve'}.`,
    });
  };
}

/* ------------------------------------------------------------------ deciding */

function canAct(req, row) {
  if (row.status !== 'pending') return false;
  if (row.initiator_user_id === req.user.id) return false;
  const step = parse(row.steps, [])[row.step];
  if (!step) return false;
  return step.approvers.includes(req.user.id) || req.perms.has('workflows.manage');
}

async function decideRequest(ctx, req, row, approve, comment) {
  const { db } = ctx;
  if (!canAct(req, row)) throw forbidden('This request isn’t waiting for you.');
  if (!approve && !comment) throw bad('Please give a reason for rejecting.');
  const steps = parse(row.steps, []);
  const step = steps[row.step];
  Object.assign(step, { status: approve ? 'approved' : 'rejected', by: req.user.id, by_name: req.user.name, at: utcNow(), comment: comment || null, override: !step.approvers.includes(req.user.id) });
  let next = -1;
  if (approve) next = steps.findIndex((s, i) => i > row.step && s.status === 'waiting');
  const data = { steps: JSON.stringify(steps) };
  if (!approve) Object.assign(data, { status: 'rejected', decided_at: utcNow() });
  else if (next >= 0) data.step = next;
  // only one decision per step, even if two approvers click at once
  const changed = await db.run(`UPDATE approval_requests SET ${Object.keys(data).map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND step = ? AND status = 'pending'`,
    [...Object.values(data), row.id, row.step]);
  if (!changed.changes) throw bad('Someone else has just decided this request.');
  await audit(db, req, approve ? 'approval.approve' : 'approval.reject', 'approval_requests', row.id, { step: row.step, comment });
  if (!approve) {
    await notifyUsers(db, row.org_id, [row.initiator_user_id], `Rejected: ${row.title}`, `${req.user.name}: ${comment}`, '#/approvals?tab=sent');
    return { result: 'rejected' };
  }
  if (next >= 0) {
    await notifyUsers(db, row.org_id, steps[next].approvers, `Waiting for your approval: ${row.title}`, `Approved by ${req.user.name} so far`, '#/approvals');
    return { result: 'forwarded', to: steps[next].label };
  }
  const done = await carryOut(ctx, { ...row, steps: JSON.stringify(steps) });
  await notifyUsers(db, row.org_id, [row.initiator_user_id], done.ok ? `Approved and done: ${row.title}` : `Approved, but it could not be done: ${row.title}`,
    done.ok ? (done.notes.length ? done.notes.join(' · ') : null) : done.error, '#/approvals?tab=sent');
  return done.ok ? { result: 'approved', notes: done.notes } : { result: 'failed', error: done.error };
}

/** A request as the approvals page shows it. */
async function present(db, req, row) {
  const steps = parse(row.steps, []);
  const ini = await db.get('SELECT name FROM users WHERE id = ?', [row.initiator_user_id]);
  const action = ACTIONS.find((a) => a.key === row.action);
  let employee = null;
  if (row.employee_id) {
    const e = await db.get('SELECT id, first_name, last_name, emp_code FROM employees WHERE id = ?', [row.employee_id]);
    if (e) employee = { id: e.id, name: fullName(e), emp_code: e.emp_code };
  }
  const followups = parse(row.followups, []);
  return {
    id: row.id, action: row.action, action_label: action ? action.label : row.action, title: row.title, status: row.status,
    initiator: { id: row.initiator_user_id, name: ini ? ini.name : '—' }, employee, created_at: row.created_at, decided_at: row.decided_at,
    step: row.step, steps: steps.map((s) => ({ label: s.label, status: s.status, by_name: s.by_name || null, at: s.at || null, comment: s.comment || null, note: s.note || null, override: !!s.override })),
    body: parse(row.body, {}), followups: followups.map((f) => ({ label: f.label || f.path, body: f.body })),
    error: row.error, result: parse(row.result, null),
    can_act: canAct(req, row), can_cancel: row.status === 'pending' && row.initiator_user_id === req.user.id,
  };
}

async function waitingCount(db, req) {
  const rows = await db.all("SELECT id, steps, step, initiator_user_id, status FROM approval_requests WHERE org_id = ? AND status = 'pending'", [req.org.id]);
  return rows.filter((r) => { const s = parse(r.steps, [])[r.step]; return s && r.initiator_user_id !== req.user.id && s.approvers.includes(req.user.id); }).length;
}

async function loadRequest(db, req, reqId) {
  const row = await db.get('SELECT * FROM approval_requests WHERE id = ? AND org_id = ?', [reqId, req.org.id]);
  if (!row) throw notFound('Request');
  return row;
}

module.exports = {
  INTERNAL, ACTIONS, STEP_TYPES, FOLLOWUPS, gate, runCall, decideRequest, present, waitingCount, loadRequest, cleanSteps, canAct, parse, resolveStep,
};
