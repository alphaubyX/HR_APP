'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, client } = require('./helpers');
const { flushDirty } = require('../server/services/attendance');
const { ensureAllocations } = require('../server/services/leave');
const { escalate } = require('../server/services/approvals');
const { loadOrg } = require('../server/services/common');
const { nowIn, addDays, weekday } = require('../server/lib/dates');

let srv;
let admin;
const PW = 'password123';

test.before(async () => {
  srv = await startServer();
  admin = client(srv.base);
  await admin.post('/api/setup', { name: 'Owner', username: 'owner', password: PW, org_name: 'Acme Ltd' });
});
test.after(async () => { await srv.close(); });

async function newEmployee(c, data) {
  return (await c.post('/api/employees', { join_date: '2025-01-01', probation_days: 0, ...data })).id;
}
async function signIn(username, password = PW) {
  const c = client(srv.base);
  await c.post('/api/login', { username, password });
  return c;
}
const workday = (d) => { while (weekday(d) >= 6) d = addDays(d, 1); return d; };

test('setup, sign-in and roles', async () => {
  const me = await admin.get('/api/me');
  assert.equal(me.org.name, 'Acme Ltd');
  assert.equal(me.role, 'admin');
  assert.equal(me.user.is_owner, true);
  const bad = await client(srv.base).call('POST', '/api/login', { username: 'owner', password: 'nope' });
  assert.equal(bad.status, 401);
  const anon = await client(srv.base).call('GET', '/api/employees');
  assert.equal(anon.status, 401);
  // mobile apps get a bearer token
  const tok = await client(srv.base).call('POST', '/api/login', { username: 'owner', password: PW, device: 'mobile' });
  const viaToken = await client(srv.base).call('GET', '/api/me', undefined, { authorization: `Bearer ${tok.data.token}` });
  assert.equal(viaToken.data.user.username, 'owner');
});

test('organizations are kept apart', async () => {
  const other = client(srv.base);
  await other.post('/api/signup', { name: 'Bob', username: 'bob', password: PW, email: 'bob@b.co', org_name: 'Beta Co' });
  const betaEmp = await newEmployee(other, { first_name: 'Beta', last_name: 'Person' });
  const acmeEmp = await newEmployee(admin, { first_name: 'Acme', last_name: 'Person' });
  assert.equal((await other.call('GET', `/api/employees/${acmeEmp}`)).status, 404);
  assert.equal((await admin.call('GET', `/api/employees/${betaEmp}`)).status, 404);
  const list = await other.get('/api/employees');
  assert.deepEqual(list.map((e) => e.first_name), ['Beta']);
  // the owner can see every organization and switch into it
  const orgs = await admin.get('/api/platform/orgs');
  assert.equal(orgs.length, 2);
  assert.equal((await other.call('GET', '/api/platform/orgs')).status, 403);
  await admin.del(`/api/employees/${acmeEmp}`);
});

test('onboarding, probation, confirmation and exit', async () => {
  const today = nowIn('Asia/Karachi').date;
  const id = (await admin.post('/api/employees', { first_name: 'Nadia', last_name: 'Khan', join_date: today })).id;
  let e = await admin.get(`/api/employees/${id}`);
  assert.equal(e.status, 'probation');
  assert.equal(e.probation_days, 90, 'organization default');
  assert.equal(e.probation_end, addDays(today, 90));
  assert.match(e.emp_code, /^EMP-\d{4}$/);
  await admin.post(`/api/employees/${id}/extend-probation`, { days: 30 });
  e = await admin.get(`/api/employees/${id}`);
  assert.equal(e.probation_end, addDays(today, 120));
  const checklist = await admin.get(`/api/employees/${id}/checklist`);
  assert.ok(checklist.length >= 5, 'onboarding checklist copied');
  await admin.post(`/api/employees/${id}/confirm`, {});
  e = await admin.get(`/api/employees/${id}`);
  assert.equal(e.status, 'permanent');
  const events = await admin.get(`/api/employees/${id}/events`);
  assert.ok(events.some((x) => x.event === 'confirmed'));
  await admin.post(`/api/employees/${id}/exit`, { exit_date: today, kind: 'resigned', notice: false });
  e = await admin.get(`/api/employees/${id}`);
  assert.equal(e.status, 'exited');
});

test('employee import from CSV', async () => {
  const csv = 'Employee Code,First Name,Last Name,Gender,Joining Date,Department,Designation,Manager Code,Machine No,Gross Salary\n'
    + 'IMP-1,Imran,Boss,M,01/02/2020,Imports Dept,Director,,701,"310,000"\n'
    + 'IMP-2,Iqra,Staff,F,2024-05-10,Imports Dept,Clerk,IMP-1,702,62000\n'
    + 'IMP-3,,NoName,M,2024-05-10,,,,,\n';
  const r = await admin.post('/api/employees/import', { csv });
  assert.equal(r.created, 2);
  assert.equal(r.salaries, 2);
  assert.equal(r.managers, 1);
  assert.equal(r.skipped.length, 1);
  const list = await admin.get('/api/employees');
  const iqra = list.find((e) => e.emp_code === 'IMP-2');
  assert.equal(iqra.manager, 'Imran Boss');
  assert.equal(iqra.department, 'Imports Dept');
  assert.equal(list.find((e) => e.emp_code === 'IMP-1').join_date, '2020-02-01', 'day-first dates understood');
  const sal = await admin.get(`/api/employees/${iqra.id}/salary`);
  assert.equal(sal[0].earnings, 62000);
});

test('organogram: moving people and refusing loops', async () => {
  const ceo = await newEmployee(admin, { first_name: 'Cee', last_name: 'Eo' });
  const mgr = await newEmployee(admin, { first_name: 'Man', last_name: 'Ager', manager_id: ceo });
  const dev = await newEmployee(admin, { first_name: 'Dev', last_name: 'Eloper', manager_id: mgr });
  const loop = await admin.call('PUT', `/api/organogram/${ceo}/manager`, { manager_id: dev });
  assert.equal(loop.status, 400);
  assert.match(loop.data.error, /reports to this employee/);
  assert.equal((await admin.call('PUT', `/api/organogram/${ceo}/manager`, { manager_id: ceo })).status, 400);
  await admin.put(`/api/organogram/${dev}/manager`, { manager_id: ceo });
  const chart = await admin.get('/api/organogram');
  assert.equal(chart.people.find((p) => p.id === dev).manager_id, ceo);
  // leaving moves their team up to their manager
  await admin.post(`/api/employees/${mgr}/exit`, { exit_date: '2025-06-01', notice: false });
  const d2 = await admin.get(`/api/employees/${dev}`);
  assert.equal(d2.manager.id, ceo);
});

test('salary: structure, revisions and who can see it', async () => {
  const lk = await admin.get('/api/lookups');
  const id = await newEmployee(admin, { first_name: 'Sal', last_name: 'Ary' });
  const lines = lk.components.filter((c) => c.active && c.kind === 'earning').map((c) => ({ component_id: c.id }));
  await admin.post(`/api/employees/${id}/salary`, { effective_from: '2025-01-01', gross: 155000, lines });
  await admin.post(`/api/employees/${id}/salary`, { effective_from: '2026-01-01', gross: 186000, lines, reason: 'Increment' });
  const revs = await admin.get(`/api/employees/${id}/salary`);
  assert.equal(revs.length, 2);
  assert.equal(revs[0].gross, 186000);
  assert.equal(revs[0].current, true);
  assert.equal(revs[0].earnings, 186000);
  assert.equal(revs[0].lines.find((l) => l.code === 'BASIC').amount, 120000);
  // an employee sees their own salary but not a colleague's
  await admin.post(`/api/employees/${id}/account`, { username: 'salary.person', password: PW });
  const emp = await signIn('salary.person');
  assert.equal((await emp.get(`/api/employees/${id}/salary`)).length, 2);
  const other = await newEmployee(admin, { first_name: 'Not', last_name: 'Mine' });
  assert.equal((await emp.call('GET', `/api/employees/${other}/salary`)).status, 403);
  assert.equal((await emp.call('GET', `/api/employees/${other}`)).status, 403);
  assert.equal((await emp.call('GET', '/api/payroll/runs')).status, 403);
  const bad = await admin.call('POST', '/api/salary-components', { name: 'Bad', code: 'BAD', calc: 'formula', formula: 'NOPE * 2' });
  assert.equal(bad.status, 400);
});

test('leave: two-level approval, absent manager skipped, HR fallback, balance', async () => {
  await admin.put('/api/org/settings', { leave_approval_levels: 2 });
  const boss = await newEmployee(admin, { first_name: 'Big', last_name: 'Boss' });
  const lead = await newEmployee(admin, { first_name: 'Team', last_name: 'Lead', manager_id: boss });
  const staff = await newEmployee(admin, { first_name: 'Staff', last_name: 'Member', manager_id: lead, gender: 'female' });
  await admin.post(`/api/employees/${boss}/account`, { username: 'boss', password: PW });
  await admin.post(`/api/employees/${lead}/account`, { username: 'lead', password: PW });
  await admin.post(`/api/employees/${staff}/account`, { username: 'staff', password: PW });
  const lk = await admin.get('/api/lookups');
  const AL = lk.leaveTypes.find((t) => t.code === 'AL').id;
  const s = await signIn('staff');
  const from = workday(addDays(nowIn('Asia/Karachi').date, 14));
  const before = (await s.get('/api/leave/balances')).balances.find((b) => b.code === 'AL');
  const { id } = await s.post('/api/leave/requests', { leave_type_id: AL, from_date: from, to_date: from, reason: 'test' });
  // overlapping request is refused
  assert.equal((await s.call('POST', '/api/leave/requests', { leave_type_id: AL, from_date: from, to_date: from })).status, 400);
  const l = await signIn('lead');
  const b = await signIn('boss');
  assert.equal((await b.call('POST', `/api/leave/requests/${id}/decide`, { approve: true })).status, 403, 'not the boss’s turn yet');
  assert.equal((await l.get('/api/leave/requests?scope=approvals')).length, 1);
  assert.equal((await l.post(`/api/leave/requests/${id}/decide`, { approve: true })).result, 'forwarded');
  assert.equal((await b.post(`/api/leave/requests/${id}/decide`, { approve: true })).result, 'approved');
  const after = (await s.get('/api/leave/balances')).balances.find((x) => x.code === 'AL');
  assert.equal(after.balance, before.balance - 1);
  // rejecting needs a reason
  const r2 = await s.post('/api/leave/requests', { leave_type_id: AL, from_date: workday(addDays(from, 3)), reason: 'x' });
  assert.equal((await l.call('POST', `/api/leave/requests/${r2.id}/decide`, { approve: false })).status, 400);
  await l.post(`/api/leave/requests/${r2.id}/decide`, { approve: false, comment: 'Busy week' });
  // the lead is on leave today: a new request skips them and goes to the boss
  const today = nowIn('Asia/Karachi').date;
  await admin.post('/api/leave/requests', { employee_id: lead, leave_type_id: lk.leaveTypes.find((t) => t.code === 'CL').id, from_date: today, to_date: today, approve_now: true });
  const r3 = await s.post('/api/leave/requests', { leave_type_id: AL, from_date: workday(addDays(from, 7)) });
  const detail = await s.get(`/api/leave/requests/${r3.id}`);
  assert.equal(detail.chain[0].name, 'Big Boss');
  assert.equal(detail.chain.length, 1, 'the boss is the only manager left; HR joins only when nobody is available');
  // HR can always step in
  await admin.post(`/api/leave/requests/${r3.id}/decide`, { approve: true });
  assert.equal((await s.get(`/api/leave/requests/${r3.id}`)).status, 'approved');
  // cancelling an approved future leave gives the days back
  await s.post(`/api/leave/requests/${r3.id}/cancel`, {});
  assert.equal((await s.get('/api/leave/balances')).balances.find((x) => x.code === 'AL').balance, before.balance - 1);
  // maternity leave applies to her; probation blocks annual leave for a newcomer
  assert.ok((await s.get('/api/leave/balances')).balances.some((x) => x.code === 'ML'));
  const newbie = await newEmployee(admin, { first_name: 'New', last_name: 'Bie', join_date: today, probation_days: 90 });
  const pr = await admin.call('POST', '/api/leave/requests', { employee_id: newbie, leave_type_id: AL, from_date: workday(addDays(today, 10)) });
  assert.equal(pr.status, 400);
  assert.match(pr.data.error, /after probation/);
  await admin.put('/api/org/settings', { leave_approval_levels: 1 });
});

test('leave: escalation after waiting too long', async () => {
  const mgr = await newEmployee(admin, { first_name: 'Slow', last_name: 'Manager' });
  const emp = await newEmployee(admin, { first_name: 'Waiting', last_name: 'Person', manager_id: mgr });
  const lk = await admin.get('/api/lookups');
  const { id } = await admin.post('/api/leave/requests', { employee_id: emp, leave_type_id: lk.leaveTypes.find((t) => t.code === 'CL').id, from_date: workday(addDays(nowIn('Asia/Karachi').date, 20)) });
  await srv.db.run("UPDATE leave_requests SET step_since = '2000-01-01 00:00:00' WHERE id = ?", [id]);
  const org = await loadOrg(srv.db, (await admin.get('/api/me')).org.id);
  assert.equal(await escalate(srv.db, org, 'leave_requests', 'leave'), 1);
  const r = await admin.get(`/api/leave/requests/${id}`);
  assert.equal(r.chain[r.step].type, 'hr');
  assert.ok(r.history.some((h) => h.action === 'escalated'));
});

test('leave year: allocation, carry forward and lapse', async () => {
  const id = await newEmployee(admin, { first_name: 'Year', last_name: 'End', join_date: '2020-01-01' });
  const org = await loadOrg(srv.db, (await admin.get('/api/me')).org.id);
  await ensureAllocations(srv.db, org, 2030);
  const AL = (await admin.get('/api/lookups')).leaveTypes.find((t) => t.code === 'AL');
  await admin.post('/api/leave/ledger', { employee_id: id, leave_type_id: AL.id, year: 2030, days: -4, note: 'Used' });
  await ensureAllocations(srv.db, org, 2031);
  const ledger = await admin.get(`/api/leave/ledger?employee_id=${id}&year=2031`);
  const carried = ledger.find((x) => x.entry === 'carry_forward' && x.leave_type_id === AL.id);
  assert.equal(carried.days, 7, '14 − 4 = 10 left, carry forward capped at 7');
  const old = await admin.get(`/api/leave/ledger?employee_id=${id}&year=2030`);
  assert.equal(old.find((x) => x.entry === 'lapse' && x.leave_type_id === AL.id).days, -3);
  const again = await ensureAllocations(srv.db, org, 2031);
  assert.equal(again, 0, 'allocations are made once per year');
});

test('attendance: device API, ZKTeco push, CSV import, mobile geofence', async () => {
  const emp = await newEmployee(admin, { first_name: 'Punch', last_name: 'Card', device_user_id: '501' });
  const dev = (await admin.post('/api/devices', { name: 'Door', kind: 'api' })).id;
  const { key } = await admin.post(`/api/devices/${dev}/key`);
  const r = await fetch(`${srv.base}/api/device/punches`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': key },
    body: JSON.stringify({ punches: [{ user_id: '501', time: '2026-09-02 09:03:00' }, { user_id: '501', time: '2026-09-02 18:01:00' }, { user_id: '501', time: '2026-09-02 18:01:30' }, { user_id: '999', time: '2026-09-02 09:00:00' }] }),
  });
  const j = await r.json();
  assert.deepEqual([j.inserted, j.duplicates, j.unmatched], [3, 1, 1]);
  assert.equal((await fetch(`${srv.base}/api/device/punches`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': 'wrong' }, body: '{}' })).status, 401);

  // ZKTeco ADMS push
  await admin.post('/api/devices', { name: 'Gate', kind: 'adms', serial_no: 'abc123' });
  const hello = await (await fetch(`${srv.base}/iclock/cdata?SN=ABC123&options=all`)).text();
  assert.match(hello, /GET OPTION FROM: ABC123/);
  const push = await fetch(`${srv.base}/iclock/cdata?SN=ABC123&table=ATTLOG&Stamp=1`, { method: 'POST', body: '501\t2026-09-03 08:59:00\t0\t1\t0\t0\n501\t2026-09-03 18:10:00\t1\t1\t0\t0\n' });
  assert.equal(await push.text(), 'OK: 2');
  assert.equal(await (await fetch(`${srv.base}/iclock/getrequest?SN=ABC123`)).text(), 'OK');

  // CSV with day-first dates
  const imp = await admin.post('/api/attendance/import', { csv: 'AC-No.,Name,Date,Time\n501,Punch,04/09/2026,09:30\n501,Punch,04/09/2026,18:00\n' });
  assert.equal(imp.inserted, 2);
  await flushDirty(srv.db);
  const sheet = await admin.get(`/api/attendance/employee/${emp}?month=2026-09`);
  const d = Object.fromEntries(sheet.days.map((x) => [x.work_date, x]));
  assert.equal(d['2026-09-02'].status, 'present');
  assert.equal(d['2026-09-03'].first_in, '2026-09-03 08:59:00');
  assert.equal(d['2026-09-04'].late_minutes, 30);
  assert.equal(d['2026-09-01'].status, 'absent');
  assert.equal(d['2026-09-05'].status, 'weekend');

  // mobile check-in inside / outside a geofence
  const lk = await admin.get('/api/lookups');
  const branch = lk.branches[0].id;
  await admin.put(`/api/branches/${branch}`, { lat: 31.5204, lng: 74.3587, radius_m: 150 });
  const mob = await newEmployee(admin, { first_name: 'Mobile', last_name: 'User', remote_attendance: 'geofence', branch_id: branch });
  await admin.post(`/api/employees/${mob}/account`, { username: 'mobile.user', password: PW });
  const m = await signIn('mobile.user');
  const far = await m.call('POST', '/api/me/punch', { lat: 31.6, lng: 74.4, accuracy: 10 });
  assert.equal(far.status, 403);
  assert.match(far.data.error, /must be within 150 m/);
  const vague = await m.call('POST', '/api/me/punch', { lat: 31.5204, lng: 74.3587, accuracy: 900 });
  assert.equal(vague.status, 400);
  const ok = await m.post('/api/me/punch', { lat: 31.5205, lng: 74.3588, accuracy: 12 });
  assert.equal(ok.inside, true);
  const today = await m.get('/api/me/attendance');
  assert.equal(today.punches.length, 1);
  await admin.put(`/api/employees/${mob}`, { remote_attendance: 'none' });
  assert.equal((await m.call('POST', '/api/me/punch', { lat: 31.5205, lng: 74.3588, accuracy: 12 })).status, 403);
});

test('attendance correction flow', async () => {
  const mgr = await newEmployee(admin, { first_name: 'Corr', last_name: 'Manager' });
  const emp = await newEmployee(admin, { first_name: 'Forgot', last_name: 'Card', manager_id: mgr });
  await admin.post(`/api/employees/${mgr}/account`, { username: 'corr.manager', password: PW });
  await admin.post(`/api/employees/${emp}/account`, { username: 'forgot.card', password: PW });
  const e = await signIn('forgot.card');
  const day = (() => { let x = addDays(nowIn('Asia/Karachi').date, -3); while (weekday(x) >= 6) x = addDays(x, -1); return x; })();
  const { id } = await e.post('/api/regularizations', { work_date: day, in_time: '09:00', out_time: '18:00', reason: 'Machine was down' });
  const m = await signIn('corr.manager');
  assert.equal((await m.get('/api/regularizations?scope=approvals')).length, 1);
  await m.post(`/api/regularizations/${id}/decide`, { approve: true });
  const att = await e.get(`/api/attendance/employee/me?month=${day.slice(0, 7)}`);
  const rec = att.days.find((x) => x.work_date === day);
  assert.equal(rec.status, 'present');
  assert.equal(rec.punch_count, 2);
});

test('payroll: process, hold, approve with loan, reopen, payslip access', async () => {
  const lk = await admin.get('/api/lookups');
  const lines = lk.components.filter((c) => c.active && c.kind === 'earning').map((c) => ({ component_id: c.id }));
  const emp = await newEmployee(admin, { first_name: 'Pay', last_name: 'Slip', attendance_required: 0 });
  await admin.post(`/api/employees/${emp}/salary`, { effective_from: '2025-01-01', gross: 155000, lines });
  await admin.post(`/api/employees/${emp}/account`, { username: 'pay.slip', password: PW });
  await admin.post('/api/loans', { employee_id: emp, amount: 20000, installment: 15000, start_month: '2026-08' });
  await admin.post('/api/adjustments', { employee_id: emp, month: '2026-08', kind: 'earning', title: 'Bonus', amount: 5000 });
  await admin.put('/api/tax-slabs', { slabs: [{ from_amount: 0, to_amount: 1200000, fixed_tax: 0, rate: 0 }, { from_amount: 1200000, to_amount: null, fixed_tax: 0, rate: 10 }] });
  const { id } = await admin.post('/api/payroll/runs', { month: '2026-08' });
  assert.equal((await admin.call('POST', '/api/payroll/runs', { month: '2026-08' })).status, 400);
  await admin.post(`/api/payroll/runs/${id}/process`);
  let run = await admin.get(`/api/payroll/runs/${id}`);
  const slip = run.slips.find((s) => s.employee_id === emp);
  const full = await admin.get(`/api/payslips/${slip.id}`);
  const amt = (src) => full.lines.filter((l) => l.source === src).reduce((a, l) => a + l.amount, 0);
  assert.equal(full.earnings, 160000);
  assert.equal(amt('loan'), 15000);
  // taxable 160000/month → 1,920,000/yr → 72,000/yr → 6,000/month
  assert.equal(amt('tax'), 6000);
  assert.equal(full.net, 160000 - 15000 - 6000);
  // employees can't see a payslip before approval
  const e = await signIn('pay.slip');
  assert.equal((await e.call('GET', `/api/payslips/${slip.id}`)).status, 403);
  await admin.post(`/api/payroll/runs/${id}/approve`);
  assert.equal((await e.get('/api/me/payslips')).length, 1);
  assert.equal((await e.get(`/api/payslips/${slip.id}`)).net, full.net);
  // the loan installment is recorded; the month is locked
  let loans = await admin.get(`/api/loans?employee_id=${emp}`);
  assert.equal(loans[0].balance, 5000);
  assert.equal((await admin.call('POST', `/api/payroll/runs/${id}/process`)).status, 400);
  assert.equal((await admin.call('POST', '/api/adjustments', { employee_id: emp, month: '2026-08', kind: 'earning', title: 'Late', amount: 1 })).status, 400);
  await admin.post(`/api/payroll/runs/${id}/reopen`);
  loans = await admin.get(`/api/loans?employee_id=${emp}`);
  assert.equal(loans[0].balance, 20000, 'reopening undoes the installment');
  await admin.post(`/api/payroll/runs/${id}/process`);
  run = await admin.get(`/api/payroll/runs/${id}`);
  assert.equal(run.status, 'processed');
  const csv = await admin.call('GET', `/api/payroll/runs/${id}/export?type=bank`);
  assert.match(csv.data, /Employee code,Name,Bank/);
});

test('Broadwing single sign-on', async () => {
  const sign = (payload, secret = 'test-secret') => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
  };
  const exp = Math.floor(Date.now() / 1000) + 60;
  const c = client(srv.base);
  const r = await c.call('GET', `/api/sso/broadwing?token=${sign({ u: 'owner', exp })}`);
  assert.equal(r.status, 302);
  assert.equal((await c.get('/api/me')).user.username, 'owner');
  assert.equal((await client(srv.base).call('GET', `/api/sso/broadwing?token=${sign({ u: 'owner', exp }, 'wrong')}`)).status, 401);
  assert.equal((await client(srv.base).call('GET', `/api/sso/broadwing?token=${sign({ u: 'owner', exp: 1 })}`)).status, 401);
});
