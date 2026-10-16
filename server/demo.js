'use strict';

/**
 * Fill an EMPTY database with a demo company, to try Broadwing HR or show it to customers:
 *   npm run seed:demo
 * Sign in as  demo / demo12345  (administrator) or  sara / demo12345  (employee with mobile check-in).
 * Uses the same database settings as the app (.env). It refuses to run on a database that has users.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { openDb } = require('./db');
const { createApp } = require('./app');
const { nowIn, addDays, weekday, addMonths } = require('./lib/dates');
const { flushDirty } = require('./services/attendance');

async function seed(base, db, { tz = 'Asia/Karachi' } = {}) {
  let cookie = '';
  async function call(method, url, body) {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url}: ${data && data.error}`);
    return data;
  }
  const post = (u, b) => call('POST', u, b);
  const put = (u, b) => call('PUT', u, b);
  const get = (u) => call('GET', u);

  await post('/api/setup', { name: 'Demo Admin', username: 'demo', password: 'demo12345', org_name: 'Alpha Traders' });
  await put('/api/org', { name: 'Alpha Traders', legal_name: 'Alpha Traders (Pvt) Ltd', address: '12 Main Boulevard, Gulberg III\nLahore, Pakistan', currency: 'PKR', timezone: tz, email: 'hr@alphatraders.pk' });
  let lk = await get('/api/lookups');
  const ho = lk.branches[0];
  await put(`/api/branches/${ho.id}`, { name: 'Head office — Gulberg', lat: 31.5204, lng: 74.3587, radius_m: 200, address: 'Main Boulevard, Gulberg III, Lahore' });
  const wh = (await post('/api/branches', { name: 'Warehouse — Kot Lakhpat', lat: 31.4697, lng: 74.3216, radius_m: 300 })).id;

  const mgmt = lk.departments[0].id;
  const dept = {};
  for (const [name, color] of [['Sales', '#0891b2'], ['Finance', '#059669'], ['Operations', '#d97706'], ['Human Resources', '#db2777'], ['Technology', '#7c3aed']]) {
    dept[name] = (await post('/api/departments', { name, color, parent_id: mgmt })).id;
  }
  const des = Object.fromEntries(lk.designations.map((d) => [d.name, d.id]));
  for (const n of ['Sales executive', 'Accountant', 'Warehouse supervisor', 'Software engineer', 'HR officer', 'Driver']) des[n] = (await post('/api/designations', { name: n })).id;
  const fieldPolicy = (await post('/api/policies', { name: 'Field staff', rules: { grace_minutes: 30, lates_per_deduction: 0, overtime_enabled: true } })).id;
  const wShift = (await post('/api/shifts', { name: 'Warehouse (8 to 5, Sat half day)', start_time: '08:00', end_time: '17:00', break_minutes: 60, weekly_off: '7', day_overrides: { 6: { start: '08:00', end: '13:00' } } })).id;

  const today = nowIn(tz).date;
  const thisMonth = today.slice(0, 7);
  const start = `${addMonths(thisMonth, -2)}-01`;
  const people = [
    ['Usman', 'Younos', 'male', 'Chief Executive', 'Management', null, 450000, 0],
    ['Ayesha', 'Malik', 'female', 'Manager', 'Human Resources', 'Usman', 220000, 0],
    ['Bilal', 'Ahmed', 'male', 'Manager', 'Sales', 'Usman', 240000, 0],
    ['Hina', 'Raza', 'female', 'Manager', 'Finance', 'Usman', 230000, 0],
    ['Kamran', 'Shah', 'male', 'Manager', 'Operations', 'Usman', 210000, 0],
    ['Sara', 'Iqbal', 'female', 'Sales executive', 'Sales', 'Bilal', 95000, 0, 'geofence'],
    ['Omar', 'Farooq', 'male', 'Sales executive', 'Sales', 'Bilal', 90000, 0, 'anywhere', fieldPolicy],
    ['Zainab', 'Hussain', 'female', 'Accountant', 'Finance', 'Hina', 110000, 0],
    ['Ali', 'Haider', 'male', 'Warehouse supervisor', 'Operations', 'Kamran', 85000, 0, 'geofence', null, wShift, wh],
    ['Fahad', 'Mirza', 'male', 'Driver', 'Operations', 'Kamran', 55000, 0, 'anywhere', fieldPolicy, wShift, wh],
    ['Mehwish', 'Anwar', 'female', 'HR officer', 'Human Resources', 'Ayesha', 80000, 45],
    ['Hamza', 'Tariq', 'male', 'Software engineer', 'Technology', 'Usman', 180000, 20],
  ];
  const ids = {};
  for (const [i, p] of people.entries()) {
    const [first, last, gender, desig, dep, mgr, gross, joinedAgo, remote = 'none', policy = null, shift = null, branch = null] = p;
    const join = joinedAgo ? addDays(today, -joinedAgo) : addDays(start, -400 + i * 30);
    const id = (await post('/api/employees', {
      first_name: first, last_name: last, gender, designation_id: des[desig], department_id: dep === 'Management' ? mgmt : dept[dep],
      manager_id: mgr ? ids[mgr] : null, join_date: join, probation_days: joinedAgo ? 90 : 0, device_user_id: String(i + 1),
      remote_attendance: remote, policy_id: policy, shift_id: shift, branch_id: branch || ho.id, phone: `0300-55500${String(i).padStart(2, '0')}`,
      email: `${first.toLowerCase()}@alphatraders.pk`, payment_method: 'bank', bank_name: 'Meezan Bank', bank_account_title: `${first} ${last}`, bank_account_no: `0101${String(100000 + i * 7919)}`,
      dob: `${1980 + (i * 3) % 20}-${String(1 + (i * 5) % 12).padStart(2, '0')}-${String(1 + (i * 7) % 27).padStart(2, '0')}`, national_id: `35202-${String(1000000 + i * 12345)}-${i % 9}`,
    })).id;
    ids[first] = id;
    const comps = (await get('/api/lookups')).components.filter((c) => c.active && c.kind === 'earning');
    await post(`/api/employees/${id}/salary`, { effective_from: join, gross, structure_id: (await get('/api/lookups')).structures[0].id, lines: comps.map((c) => ({ component_id: c.id })), reason: 'Joining salary', allow_backdated: true });
  }
  await put(`/api/departments/${mgmt}`, { head_employee_id: ids.Usman });
  for (const [name, head] of [['Sales', 'Bilal'], ['Finance', 'Hina'], ['Operations', 'Kamran'], ['Human Resources', 'Ayesha']]) await put(`/api/departments/${dept[name]}`, { head_employee_id: ids[head] });
  for (const [name, n] of [['Sales', 6], ['Finance', 3], ['Operations', 5], ['Human Resources', 2]]) await put(`/api/departments/${dept[name]}`, { approved_strength: n });
  await post('/api/sections', { department_id: dept.Sales, name: 'Field Sales', approved_strength: 4 });
  await post('/api/sections', { department_id: dept.Sales, name: 'Key Accounts', approved_strength: 2 });
  await post('/api/sections', { department_id: dept.Finance, name: 'Accounts', approved_strength: 2 });
  await post(`/api/employees/${ids.Sara}/account`, { username: 'sara', password: 'demo12345', role: 'employee' });
  await post(`/api/employees/${ids.Bilal}/account`, { username: 'bilal', password: 'demo12345', role: 'employee' });
  await post(`/api/employees/${ids.Ayesha}/account`, { username: 'ayesha', password: 'demo12345', role: 'hr' });
  await put(`/api/employees/${ids.Sara}/geofences`, { branch_ids: [ho.id] });
  await put(`/api/employees/${ids.Ali}/geofences`, { branch_ids: [wh] });

  // holidays and an exceptional rainy day
  const y = Number(today.slice(0, 4));
  for (const [d, n] of [[`${y}-02-05`, 'Kashmir Day'], [`${y}-03-23`, 'Pakistan Day'], [`${y}-05-01`, 'Labour Day'], [`${y}-08-14`, 'Independence Day'], [`${y}-11-09`, 'Iqbal Day'], [`${y}-12-25`, 'Quaid-e-Azam Day']]) {
    await post('/api/holidays', { holiday_date: d, name: n, kind: 'public' });
  }
  const rainy = (() => { let d = addDays(today, -9); while (weekday(d) >= 6) d = addDays(d, -1); return d; })();
  await post('/api/holidays', { holiday_date: rainy, name: 'Heavy rain — late arrivals excused', kind: 'exceptional', treatment: 'relaxed' });
  await put('/api/tax-slabs', { slabs: [
    { from_amount: 0, to_amount: 600000, fixed_tax: 0, rate: 0 }, { from_amount: 600000, to_amount: 1200000, fixed_tax: 0, rate: 1 },
    { from_amount: 1200000, to_amount: 2200000, fixed_tax: 6000, rate: 11 }, { from_amount: 2200000, to_amount: 3200000, fixed_tax: 116000, rate: 23 },
    { from_amount: 3200000, to_amount: 4100000, fixed_tax: 346000, rate: 30 }, { from_amount: 4100000, to_amount: null, fixed_tax: 616000, rate: 35 },
  ] });

  // machine punches for the last two months, with a few lates and absences
  let seedN = 7;
  const rnd = () => { seedN = (seedN * 16807) % 2147483647; return seedN / 2147483647; };
  const punches = [];
  const emps = Object.entries(ids);
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const wd = weekday(d);
    for (const [name] of emps) {
      const warehouse = name === 'Ali' || name === 'Fahad';
      if ((!warehouse && wd >= 6) || (warehouse && wd === 7)) continue;
      const r = rnd();
      if (r < 0.04 && name !== 'Usman') continue; // absent
      const startH = warehouse ? 8 : 9;
      let inMin = startH * 60 - 10 + Math.floor(rnd() * 22);
      if (r > 0.9) inMin += 20 + Math.floor(rnd() * 50); // late
      let outMin = (warehouse && wd === 6 ? 13 : startH + 9) * 60 + Math.floor(rnd() * 40) - 5;
      if (d === today) { const nowMin = Number(nowIn(tz).time.slice(0, 2)) * 60 + Number(nowIn(tz).time.slice(3, 5)); if (inMin > nowMin) continue; if (outMin > nowMin) outMin = null; }
      const fmt = (m) => `${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`;
      const pin = String(people.findIndex((p) => p[0] === name) + 1);
      punches.push({ user_id: pin, time: fmt(inMin) });
      if (outMin) punches.push({ user_id: pin, time: fmt(outMin) });
    }
  }
  const dev = (await post('/api/devices', { name: 'Head office entrance', kind: 'api', branch_id: ho.id })).id;
  const { key } = await post(`/api/devices/${dev}/key`);
  await post('/api/devices', { name: 'Warehouse gate', kind: 'adms', serial_no: 'CQZ7231560012', branch_id: wh });
  const res = await fetch(`${base}/api/device/punches`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': key }, body: JSON.stringify({ punches }) });
  if (!res.ok) throw new Error('punch upload failed');
  await flushDirty(db);

  // leave
  const lt = Object.fromEntries((await get('/api/lookups')).leaveTypes.map((t) => [t.code, t.id]));
  const nextWorkday = (d) => { while (weekday(d) >= 6) d = addDays(d, 1); return d; };
  const past = nextWorkday(addDays(today, -20));
  await post('/api/leave/requests', { employee_id: ids.Zainab, leave_type_id: lt.AL, from_date: past, to_date: addDays(past, 1), reason: 'Family wedding', approve_now: true });
  const soon = nextWorkday(addDays(today, 6));
  await post('/api/leave/requests', { employee_id: ids.Sara, leave_type_id: lt.CL, from_date: soon, to_date: soon, reason: 'Personal errand' });
  await post('/api/leave/requests', { employee_id: ids.Omar, leave_type_id: lt.SL, from_date: nextWorkday(addDays(today, 2)), half_day: 'first', reason: 'Doctor appointment' });
  await post('/api/loans', { employee_id: ids.Ali, kind: 'loan', amount: 60000, installment: 10000, start_month: addMonths(thisMonth, -1), reason: 'Motorbike' });
  await post('/api/adjustments', { employee_id: ids.Bilal, month: addMonths(thisMonth, -1), kind: 'earning', title: 'Sales target bonus', amount: 25000, taxable: true });

  // last month's payroll, processed and approved
  const run = (await post('/api/payroll/runs', { month: addMonths(thisMonth, -1) })).id;
  await post(`/api/payroll/runs/${run}/process`);
  await post(`/api/payroll/runs/${run}/approve`);
  await post(`/api/payroll/runs/${run}/paid`);
  return { punches: punches.length };
}

async function main() {
  const env = process.env;
  const client = (env.HR_DB_CLIENT || (env.HR_DB_NAME ? 'mysql' : 'sqlite')).toLowerCase();
  const ROOT = path.join(__dirname, '..');
  const dataDir = path.resolve(ROOT, env.HR_DATA_DIR || 'data');
  const db = await openDb(client === 'mysql'
    ? { client, host: env.HR_DB_HOST || 'localhost', port: env.HR_DB_PORT, user: env.HR_DB_USER, password: env.HR_DB_PASSWORD, database: env.HR_DB_NAME, socketPath: env.HR_DB_SOCKET }
    : { client: 'sqlite', file: path.resolve(ROOT, env.HR_SQLITE_FILE || path.join(dataDir, 'hr.db')) });
  const app = await createApp({ db, dataDir: dataDir || os.tmpdir(), signup: false });
  if (Number(await db.value('SELECT COUNT(*) FROM users'))) {
    console.error('The database already has users. The demo only fills an empty database.');
    process.exit(1);
  }
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const r = await seed(`http://127.0.0.1:${server.address().port}`, db);
    console.log(`Demo company created with ${r.punches} attendance punches.`);
    console.log('Sign in as demo / demo12345 (administrator), ayesha (HR), bilal (manager) or sara (employee); password demo12345.');
  } finally {
    server.close();
    await db.close();
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { seed };
