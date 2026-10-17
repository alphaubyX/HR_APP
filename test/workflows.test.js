'use strict';

/** Roles you can change, and approval workflows (Action → Initiator → Approver 1 → Approver 2 …). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client } = require('./helpers');

const PW = 'password123';
let srv;
let admin;
let hr;
let ce;
let ceRole;

async function signIn(username) {
  const c = client(srv.base);
  await c.post('/api/login', { username, password: PW });
  return c;
}

test.before(async () => {
  srv = await startServer();
  admin = client(srv.base);
  await admin.post('/api/setup', { name: 'Owner', username: 'owner', password: PW, org_name: 'Acme Ltd' });
});
test.after(async () => { await srv.close(); });

test('roles: your own roles, rights you can tick, and who may change them', async () => {
  const { roles, permissions } = await admin.get('/api/roles');
  assert.deepEqual(roles.map((r) => r.role_key), ['admin', 'hr', 'payroll', 'employee']);
  assert.ok(permissions.some((p) => p.key === 'workflows.manage'));
  ceRole = await admin.post('/api/roles', { name: 'Chief Executive', copy_from: 'employee' });
  assert.equal(ceRole.role_key, 'chief_executive');
  await admin.put(`/api/roles/${ceRole.id}`, { perms: ['employees.view', 'reports.view', 'made.up'] });
  const after = (await admin.get('/api/roles')).roles.find((r) => r.role_key === 'chief_executive');
  assert.deepEqual(after.perms.sort(), ['employees.view', 'reports.view'], 'unknown rights are dropped');
  // the Administrator role can't lose rights
  const adminRole = roles.find((r) => r.role_key === 'admin');
  assert.equal((await admin.call('PUT', `/api/roles/${adminRole.id}`, { perms: [] })).status, 400);

  const ceEmp = (await admin.post('/api/employees', { first_name: 'Chief', last_name: 'Exec', join_date: '2025-01-01', probation_days: 0 })).id;
  const hrEmp = (await admin.post('/api/employees', { first_name: 'Hira', last_name: 'HR', join_date: '2025-01-01', probation_days: 0, manager_id: ceEmp })).id;
  await admin.post(`/api/employees/${ceEmp}/account`, { username: 'chief', password: PW, role: 'chief_executive' });
  await admin.post(`/api/employees/${hrEmp}/account`, { username: 'hira', password: PW, role: 'hr' });
  ce = await signIn('chief');
  hr = await signIn('hira');
  const me = await ce.get('/api/me');
  assert.equal(me.roleLabel, 'Chief Executive');
  assert.deepEqual(me.perms.sort(), ['employees.view', 'reports.view']);

  // HR may give out roles but not change rights, make administrators or hand out rights they lack
  assert.equal((await hr.call('PUT', `/api/roles/${ceRole.id}`, { perms: ['payroll.run'] })).status, 403);
  const someone = (await admin.post('/api/employees', { first_name: 'Some', last_name: 'One', join_date: '2025-01-01', probation_days: 0 })).id;
  assert.match((await hr.call('POST', `/api/employees/${someone}/account`, { username: 'some', password: PW, role: 'admin' })).data.error, /administrator/);
  assert.match((await hr.call('POST', `/api/employees/${someone}/account`, { username: 'some', password: PW, role: 'payroll' })).data.error, /rights you don't have/);
  await hr.post(`/api/employees/${someone}/account`, { username: 'some', password: PW, role: 'employee' });

  // unticking a right takes it away
  const hrRole = roles.find((r) => r.role_key === 'hr');
  await admin.put(`/api/roles/${hrRole.id}`, { perms: hrRole.perms.filter((p) => p !== 'reports.view') });
  assert.ok(!(await hr.get('/api/me')).perms.includes('reports.view'));
  await admin.put(`/api/roles/${hrRole.id}`, { perms: hrRole.perms });

  // a role in use can't be deleted; a starting role never
  assert.match((await admin.call('DELETE', `/api/roles/${ceRole.id}`)).data.error, /has this role/);
  assert.equal((await admin.call('DELETE', `/api/roles/${hrRole.id}`)).status, 400);
});

test('workflow: HR adds an employee, the CE approves, then it happens', async () => {
  assert.equal((await hr.call('GET', '/api/workflows')).status, 403, 'setting up workflows is a right of its own');
  assert.equal((await admin.call('PUT', '/api/workflows/employee.create', { active: true, steps: [] })).status, 400);
  await admin.put('/api/workflows/employee.create', { active: true, steps: [{ type: 'role', role_key: 'chief_executive' }] });

  const sent = await hr.call('POST', '/api/employees', { first_name: 'New', last_name: 'Joiner', join_date: '2026-01-05', probation_days: 90 });
  assert.equal(sent.status, 202);
  assert.equal(sent.data.pending, true);
  assert.match(sent.data.message, /Chief Executive/);
  await hr.post(`/api/approvals/${sent.data.approval_id}/followups`, { calls: [{ method: 'PUT', path: '/employees/{id}/geofences', body: { branch_ids: [] }, label: 'Geofences' }] });
  assert.equal((await hr.call('POST', `/api/approvals/${sent.data.approval_id}/followups`, { calls: [{ method: 'DELETE', path: '/employees/{id}' }] })).status, 400);
  assert.ok(!(await admin.get('/api/employees')).some((e) => e.first_name === 'New'), 'nothing happens before approval');

  // HR sees it under "sent", can't approve it; the CE has it waiting
  const mine = await hr.get('/api/approvals?scope=sent');
  assert.equal(mine[0].status, 'pending');
  assert.equal(mine[0].can_act, false);
  assert.equal((await hr.call('POST', `/api/approvals/${sent.data.approval_id}/decide`, { approve: true })).status, 403);
  const waiting = await ce.get('/api/approvals');
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].title, 'Add a new employee: New Joiner');
  assert.equal(waiting[0].body.first_name, 'New');
  assert.equal((await ce.get('/api/dashboard')).approvals.requests, 1);

  const out = await ce.post(`/api/approvals/${sent.data.approval_id}/decide`, { approve: true });
  assert.equal(out.result, 'approved');
  const joiner = (await admin.get('/api/employees')).find((e) => e.first_name === 'New');
  assert.ok(joiner, 'created once approved');
  assert.equal(joiner.status, 'probation');
  const done = await hr.get(`/api/approvals/${sent.data.approval_id}`);
  assert.equal(done.status, 'approved');
  assert.equal(done.result.id, joiner.id);
  assert.equal(done.steps[0].by_name, 'Chief Exec');
});

test('workflow: rejection needs a reason, withdrawing, and failures are reported', async () => {
  const r1 = (await hr.call('POST', '/api/employees', { first_name: 'Not', last_name: 'Needed', join_date: '2026-01-05' })).data;
  assert.equal((await ce.call('POST', `/api/approvals/${r1.approval_id}/decide`, { approve: false })).status, 400);
  assert.equal((await ce.post(`/api/approvals/${r1.approval_id}/decide`, { approve: false, comment: 'No budget' })).result, 'rejected');
  assert.equal((await hr.get(`/api/approvals/${r1.approval_id}`)).status, 'rejected');
  assert.ok(!(await admin.get('/api/employees')).some((e) => e.first_name === 'Not'));

  const r2 = (await hr.call('POST', '/api/employees', { first_name: 'Changed', last_name: 'Mind', join_date: '2026-01-05' })).data;
  await hr.post(`/api/approvals/${r2.approval_id}/cancel`, {});
  assert.equal((await ce.get('/api/approvals')).length, 0);

  // approved but the data is no good: it says why instead of half-doing it
  const r3 = (await hr.call('POST', '/api/employees', { first_name: 'Bad', join_date: 'not a date' })).data;
  const out = await ce.post(`/api/approvals/${r3.approval_id}/decide`, { approve: true });
  assert.equal(out.result, 'failed');
  assert.match(out.error, /date/i);
  assert.equal((await hr.get(`/api/approvals/${r3.approval_id}`)).status, 'failed');
});

test('workflow: two approvers in order, administrators can step in, own requests skip yourself', async () => {
  const owner = (await admin.get('/api/me')).user.id;
  await admin.put('/api/workflows/employee.create', { active: true, steps: [{ type: 'initiator_manager' }, { type: 'user', user_id: owner }] });
  const r = (await hr.call('POST', '/api/employees', { first_name: 'Two', last_name: 'Step', join_date: '2026-01-05' })).data;
  const detail = await hr.get(`/api/approvals/${r.approval_id}`);
  assert.equal(detail.steps[0].label, 'Initiator’s line manager (Chief Exec)');
  assert.equal(detail.steps[1].label, 'Owner');
  assert.equal((await ce.post(`/api/approvals/${r.approval_id}/decide`, { approve: true })).result, 'forwarded');
  assert.equal((await ce.call('POST', `/api/approvals/${r.approval_id}/decide`, { approve: true })).status, 403, 'not the CE’s turn any more');
  assert.equal((await admin.post(`/api/approvals/${r.approval_id}/decide`, { approve: true })).result, 'approved');
  assert.ok((await admin.get('/api/employees')).some((e) => e.first_name === 'Two'));

  // the owner starts it: the owner's own step is skipped, but the line-manager step has nobody → done directly
  const direct = await admin.call('POST', '/api/employees', { first_name: 'Direct', join_date: '2026-01-05' });
  assert.equal(direct.status, 200);
  assert.ok(direct.data.id);

  // an administrator (workflows.manage) can decide any step, e.g. when the approver is away
  await admin.put('/api/workflows/salary.revise', { active: true, steps: [{ type: 'role', role_key: 'chief_executive' }] });
  await admin.put('/api/workflows/employee.create', { active: false, steps: [{ type: 'role', role_key: 'chief_executive' }] });
  const plain = await hr.call('POST', '/api/employees', { first_name: 'Off', join_date: '2026-01-05' });
  assert.equal(plain.status, 200, 'a switched-off workflow changes nothing');

  // a role nobody holds goes to the administrators instead of letting the action through
  const empty = await admin.post('/api/roles', { name: 'Board' });
  await admin.put('/api/workflows/employee.create', { active: true, steps: [{ type: 'role', role_key: empty.role_key }] });
  const gap = await hr.call('POST', '/api/employees', { first_name: 'Gap', join_date: '2026-01-05' });
  assert.equal(gap.status, 202);
  assert.equal((await admin.get(`/api/approvals/${gap.data.approval_id}`)).steps[0].label, 'Board → administrators');
  assert.equal((await admin.get('/api/approvals')).length, 1);
  await admin.put('/api/workflows/employee.create', { active: false, steps: [] });

  const wfs = await admin.get('/api/workflows');
  assert.ok(wfs.actions.find((a) => a.key === 'employee.create').initiators.includes('HR manager'));
});
