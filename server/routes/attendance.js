'use strict';

const { need, inOrg, sha256, newToken } = require('../lib/auth');
const { pick, bad, notFound, forbidden, HttpError } = require('../lib/validate');
const { utcNow, nowIn, addDays, eachDay, isDate, isMonth, payPeriod } = require('../lib/dates');
const { matchGeofence } = require('../lib/geo');
const { summarize } = require('../engine/attendance');
const { processRange, ingestPunches, markDirty, flushDirty, DAY_COLUMNS } = require('../services/attendance');
const { buildChain, parseChain, canAct, decide, notifyStep, recordAction } = require('../services/approvals');
const { audit, employeeScope, inScope, fullName, loadPolicies, notifyEmployees } = require('../services/common');
const { crud } = require('./crud');

module.exports = function attendanceRoutes(r, { db }) {
  const today = (req) => nowIn(req.org.timezone).date;

  async function visibleIds(req, perm = 'attendance.view') {
    const scope = await employeeScope(req, perm);
    return scope;
  }

  async function employeeFor(req, id, perm = 'attendance.view') {
    const empId = Number(id) || req.member.employee_id;
    if (!empId) throw bad('Your account is not linked to an employee record.');
    const e = await db.get('SELECT * FROM employees WHERE id = ? AND org_id = ?', [empId, req.org.id]);
    if (!e) throw notFound('Employee');
    if (!inScope(await employeeScope(req, perm), e.id)) throw forbidden('You can only see your own team.');
    return e;
  }

  /* ------------------------------------------------------------ daily board */
  r.get('/attendance/day', inOrg, async (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : today(req);
    const scope = await visibleIds(req);
    let employees = await db.all(
      `SELECT e.id, e.emp_code, e.first_name, e.last_name, e.department_id, e.branch_id, e.photo IS NOT NULL AS has_photo, d.name AS department
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.org_id = ? AND e.join_date <= ? AND (e.exit_date IS NULL OR e.exit_date >= ?) AND e.status NOT IN ('exited', 'onboarding')
       ORDER BY e.first_name`, [req.org.id, date, date]);
    if (!scope.all) employees = employees.filter((e) => scope.ids.has(e.id));
    if (req.query.department_id) employees = employees.filter((e) => e.department_id === Number(req.query.department_id));
    const ids = employees.map((e) => e.id);
    if (ids.length && date <= today(req)) await processRange(db, req.org.id, { from: date, to: date, employeeIds: ids });
    const days = ids.length ? await db.all(
      `SELECT * FROM attendance_days WHERE org_id = ? AND work_date = ? AND employee_id IN (${ids.map(() => '?').join(',')})`, [req.org.id, date, ...ids]) : [];
    const byEmp = new Map(days.map((d) => [d.employee_id, d]));
    const rows = employees.map((e) => ({ ...e, name: fullName(e), has_photo: !!Number(e.has_photo), day: byEmp.get(e.id) || null }));
    const count = (s) => rows.filter((x) => x.day && x.day.status === s).length;
    res.json({
      date,
      rows,
      totals: {
        people: rows.length, present: count('present') + count('half_day') + count('missing') + count('half_leave'), absent: count('absent'),
        leave: count('leave'), late: rows.filter((x) => x.day && x.day.late_minutes > 0).length, off: count('weekend') + count('holiday'),
        missing: count('missing'), not_in: rows.filter((x) => !x.day || (x.day.punch_count === 0 && ['absent', 'present'].includes(x.day.status))).length,
      },
    });
  });

  /* ---------------------------------------------------- monthly attendance sheet */
  r.get('/attendance/sheet', inOrg, async (req, res) => {
    const month = isMonth(req.query.month) ? req.query.month : today(req).slice(0, 7);
    const { start, end } = payPeriod(month, req.org.settings.payroll_period_start_day);
    const scope = await visibleIds(req);
    let employees = await db.all(
      `SELECT id, emp_code, first_name, last_name, department_id, policy_id FROM employees
       WHERE org_id = ? AND join_date <= ? AND (exit_date IS NULL OR exit_date >= ?) AND status <> 'onboarding' ORDER BY first_name`, [req.org.id, end, start]);
    if (!scope.all) employees = employees.filter((e) => scope.ids.has(e.id));
    if (req.query.department_id) employees = employees.filter((e) => e.department_id === Number(req.query.department_id));
    const ids = employees.map((e) => e.id);
    if (ids.length && (req.query.refresh || start <= today(req))) {
      // only recalculate when asked, or when days are missing
      const have = Number(await db.value(`SELECT COUNT(*) FROM attendance_days WHERE org_id = ? AND work_date >= ? AND work_date <= ? AND employee_id IN (${ids.map(() => '?').join(',')})`, [req.org.id, start, end, ...ids]));
      const expected = ids.length * eachDay(start, end < today(req) ? end : today(req)).length;
      if (req.query.refresh || have < expected) await processRange(db, req.org.id, { from: start, to: end, employeeIds: ids });
    }
    const days = ids.length ? await db.all(
      `SELECT employee_id, work_date, status, late_minutes, early_minutes, worked_minutes, overtime_minutes, ot_rate, deduction_days, first_in, last_out, manual, remarks, leave_paid, leave_request_id
       FROM attendance_days WHERE org_id = ? AND work_date >= ? AND work_date <= ? AND employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY work_date`,
      [req.org.id, start, end, ...ids]) : [];
    const policies = await loadPolicies(db, req.org.id);
    const rows = employees.map((e) => {
      const mine = days.filter((d) => d.employee_id === e.id);
      const rules = ((e.policy_id && policies.byId.get(e.policy_id)) || policies.default).rules;
      return { id: e.id, emp_code: e.emp_code, name: fullName(e), department_id: e.department_id, days: mine, summary: summarize(mine, rules) };
    });
    res.json({ month, start, end, dates: eachDay(start, end), rows });
  });

  r.get('/attendance/employee/:id', inOrg, async (req, res) => {
    const e = await employeeFor(req, req.params.id === 'me' ? null : req.params.id);
    const month = isMonth(req.query.month) ? req.query.month : today(req).slice(0, 7);
    const { start, end } = payPeriod(month, req.org.settings.payroll_period_start_day);
    await processRange(db, req.org.id, { from: start, to: end, employeeIds: [e.id] });
    const days = await db.all('SELECT * FROM attendance_days WHERE org_id = ? AND employee_id = ? AND work_date >= ? AND work_date <= ? ORDER BY work_date', [req.org.id, e.id, start, end]);
    const policies = await loadPolicies(db, req.org.id);
    const policy = (e.policy_id && policies.byId.get(e.policy_id)) || policies.default;
    const punches = await db.all(
      `SELECT p.*, b.name AS branch_name, d.name AS device_name FROM punches p LEFT JOIN branches b ON b.id = p.branch_id LEFT JOIN devices d ON d.id = p.device_id
       WHERE p.org_id = ? AND p.employee_id = ? AND p.punch_time >= ? AND p.punch_time < ? ORDER BY p.punch_time`,
      [req.org.id, e.id, `${addDays(start, -1)} 00:00:00`, `${addDays(end, 2)} 00:00:00`]);
    res.json({ employee: { id: e.id, name: fullName(e), emp_code: e.emp_code }, month, start, end, days, punches, policy: { name: policy.name, rules: policy.rules }, summary: summarize(days, policy.rules) });
  });

  /** HR sets a day by hand (e.g. official visit, forgot card). Processing keeps it. */
  r.put('/attendance/days/:employeeId/:date', need('attendance.manage'), async (req, res) => {
    const e = await employeeFor(req, req.params.employeeId, 'attendance.manage');
    if (!isDate(req.params.date)) throw bad('Bad date.');
    const b = pick(req.body, {
      status: ['str', { required: true, oneOf: ['present', 'half_day', 'absent', 'leave', 'holiday', 'weekend', 'off'] }],
      deduction_days: ['num', { min: 0, max: 5, default: 0 }], note: ['str', { required: true, max: 300 }],
      late_minutes: ['int', { min: 0, max: 1440, default: 0 }], overtime_minutes: ['int', { min: 0, max: 1440, default: 0 }],
    });
    const now = utcNow();
    const row = {
      org_id: req.org.id, employee_id: e.id, work_date: req.params.date, status: b.status, shift_start: null, shift_end: null, first_in: null, last_out: null,
      punch_count: 0, worked_minutes: 0, late_minutes: b.late_minutes, early_minutes: 0, short_minutes: 0, overtime_minutes: b.overtime_minutes,
      ot_rate: b.overtime_minutes ? 1 : 0, deduction_days: b.deduction_days, leave_request_id: null, leave_paid: null, holiday_id: null,
      remarks: 'Set by HR', manual: 1, manual_note: b.note, processed_at: now,
    };
    await db.tx(async (t) => {
      await t.run('DELETE FROM attendance_days WHERE employee_id = ? AND work_date = ?', [e.id, req.params.date]);
      await t.run(`INSERT INTO attendance_days (${DAY_COLUMNS.join(',')}) VALUES (${DAY_COLUMNS.map(() => '?').join(',')})`, DAY_COLUMNS.map((c) => row[c] ?? null));
    });
    await audit(db, req, 'attendance.override', 'employees', e.id, { date: req.params.date, ...b });
    res.json({ ok: true });
  });

  r.delete('/attendance/days/:employeeId/:date', need('attendance.manage'), async (req, res) => {
    const e = await employeeFor(req, req.params.employeeId, 'attendance.manage');
    await db.run('DELETE FROM attendance_days WHERE employee_id = ? AND work_date = ? AND manual = 1', [e.id, req.params.date]);
    await processRange(db, req.org.id, { from: req.params.date, to: req.params.date, employeeIds: [e.id] });
    await audit(db, req, 'attendance.override_removed', 'employees', e.id, { date: req.params.date });
    res.json({ ok: true });
  });

  r.post('/attendance/process', need('attendance.manage'), async (req, res) => {
    const b = pick(req.body, { from: ['date', { required: true }], to: ['date', { required: true }] });
    if (b.to < b.from) throw bad('"To" is before "from".');
    if (eachDay(b.from, b.to).length > 62) throw bad('Process at most two months at a time.');
    const n = await processRange(db, req.org.id, { from: b.from, to: b.to });
    res.json({ days: n });
  });

  /* ---------------------------------------------------------------- punches */
  r.get('/punches', inOrg, async (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : today(req);
    const to = isDate(req.query.to) ? req.query.to : from;
    let sql = `SELECT p.*, e.first_name, e.last_name, e.emp_code, b.name AS branch_name, d.name AS device_name
               FROM punches p LEFT JOIN employees e ON e.id = p.employee_id LEFT JOIN branches b ON b.id = p.branch_id LEFT JOIN devices d ON d.id = p.device_id
               WHERE p.org_id = ? AND p.punch_time >= ? AND p.punch_time < ?`;
    const params = [req.org.id, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`];
    const scope = await visibleIds(req);
    if (req.query.employee_id) { sql += ' AND p.employee_id = ?'; params.push(Number(req.query.employee_id)); }
    if (req.query.source) { sql += ' AND p.source = ?'; params.push(String(req.query.source)); }
    if (req.query.unmatched) sql += ' AND p.employee_id IS NULL';
    let rows = await db.all(`${sql} ORDER BY p.punch_time DESC LIMIT 2000`, params);
    if (!scope.all) rows = rows.filter((p) => p.employee_id && scope.ids.has(p.employee_id));
    res.json(rows.map((p) => ({ ...p, name: p.first_name ? fullName(p) : null })));
  });

  /** Machine numbers that have punches but no employee yet: link them on the employee's profile. */
  r.get('/punches/unmatched', need('attendance.manage'), async (req, res) => {
    res.json(await db.all(
      `SELECT device_user_id, COUNT(*) AS punches, MIN(punch_time) AS first_seen, MAX(punch_time) AS last_seen FROM punches
       WHERE org_id = ? AND employee_id IS NULL AND device_user_id IS NOT NULL GROUP BY device_user_id ORDER BY device_user_id`, [req.org.id]));
  });

  r.post('/punches', need('attendance.manage'), async (req, res) => {
    const b = pick(req.body, {
      employee_id: ['id', { required: true }], date: ['date', { required: true }], time: ['time', { required: true }],
      direction: ['str', { oneOf: ['in', 'out', 'auto'], default: 'auto' }], note: ['str', { required: true, max: 300 }],
    });
    await employeeFor(req, b.employee_id, 'attendance.manage');
    const r1 = await ingestPunches(db, req.org.id, [{ employee_id: b.employee_id, time: `${b.date} ${b.time}`, direction: b.direction, note: b.note }], { source: 'manual', userId: req.user.id });
    if (!r1.inserted) throw bad('There is already a punch at that minute.');
    await flushDirty(db);
    await audit(db, req, 'punches.add', 'employees', b.employee_id, b);
    res.json({ ok: true });
  });

  r.delete('/punches/:id', need('attendance.manage'), async (req, res) => {
    const p = await db.get('SELECT * FROM punches WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!p) throw notFound('Punch');
    await db.run('DELETE FROM punches WHERE id = ?', [p.id]);
    if (p.employee_id) { markDirty(req.org.id, p.employee_id, p.punch_time.slice(0, 10)); await flushDirty(db); }
    await audit(db, req, 'punches.delete', 'employees', p.employee_id, { time: p.punch_time, source: p.source });
    res.json({ ok: true });
  });

  /* --------------------------------------------------- mobile attendance */
  async function mobileContext(req) {
    const empId = req.member.employee_id;
    if (!empId) throw bad('Your account is not linked to an employee record.');
    const e = await db.get('SELECT * FROM employees WHERE id = ? AND org_id = ?', [empId, req.org.id]);
    if (!e || ['exited', 'suspended', 'onboarding'].includes(e.status)) throw forbidden('Attendance is not open for your account.');
    let fences = await db.all(
      'SELECT b.* FROM employee_geofences g JOIN branches b ON b.id = g.branch_id WHERE g.employee_id = ? AND b.active = 1', [e.id]);
    if (!fences.length && e.branch_id) fences = await db.all('SELECT * FROM branches WHERE id = ? AND active = 1', [e.branch_id]);
    fences = fences.filter((f) => f.lat !== null && f.lng !== null);
    return { e, fences };
  }

  r.get('/me/attendance', inOrg, async (req, res) => {
    const { e, fences } = await mobileContext(req);
    const date = today(req);
    await processRange(db, req.org.id, { from: addDays(date, -1), to: date, employeeIds: [e.id] });
    const day = await db.get('SELECT * FROM attendance_days WHERE employee_id = ? AND work_date = ?', [e.id, date]);
    const punches = await db.all(
      `SELECT p.id, p.punch_time, p.source, p.direction, p.branch_id, p.distance_m, b.name AS branch_name FROM punches p LEFT JOIN branches b ON b.id = p.branch_id
       WHERE p.org_id = ? AND p.employee_id = ? AND p.punch_time >= ? ORDER BY p.punch_time`, [req.org.id, e.id, `${addDays(date, -1)} 00:00:00`]);
    res.json({
      mode: e.remote_attendance, date, now: nowIn(req.org.timezone).datetime, day,
      punches: punches.filter((p) => p.punch_time.slice(0, 10) === date || (day && day.first_in && p.punch_time >= day.first_in)),
      fences: fences.map((f) => ({ id: f.id, name: f.name, lat: f.lat, lng: f.lng, radius_m: f.radius_m })),
      maxAccuracy: req.org.settings.mobile_accuracy_m,
    });
  });

  r.post('/me/punch', inOrg, async (req, res) => {
    const { e, fences } = await mobileContext(req);
    if (e.remote_attendance === 'none') throw forbidden('Mobile attendance is not switched on for you. Please use the attendance machine.');
    const b = pick(req.body, {
      lat: ['num', { required: true, min: -90, max: 90 }], lng: ['num', { required: true, min: -180, max: 180 }],
      accuracy: ['num', { min: 0, max: 100000 }], direction: ['str', { oneOf: ['in', 'out', 'auto'], default: 'auto' }], note: ['str', { max: 300 }],
    });
    const maxAcc = req.org.settings.mobile_accuracy_m;
    if (b.accuracy && b.accuracy > maxAcc) {
      throw bad(`Your location is not precise enough (±${Math.round(b.accuracy)} m, need ±${maxAcc} m). Turn on GPS / precise location and try again outdoors or near a window.`);
    }
    const match = matchGeofence(b.lat, b.lng, fences);
    if (e.remote_attendance === 'geofence') {
      if (!fences.length) throw forbidden('No office location is set up for you yet. Please ask HR.');
      if (!match.inside) {
        const n = match.nearest;
        throw new HttpError(403, `You are ${Math.round(n.distance)} m from ${n.branch.name}. You must be within ${n.branch.radius_m} m to mark attendance.`);
      }
    }
    if (e.remote_attendance === 'anywhere' && !match.inside && req.org.settings.mobile_require_note_anywhere && !b.note) {
      throw bad('You are away from the office: please add a note (e.g. client visit).');
    }
    const now = nowIn(req.org.timezone).datetime;
    const n = match.nearest;
    const r1 = await ingestPunches(db, req.org.id, [{
      employee_id: e.id, time: now, direction: b.direction, lat: b.lat, lng: b.lng, accuracy_m: b.accuracy,
      branch_id: n && match.inside ? n.branch.id : null, distance_m: n ? Math.round(n.distance) : null, note: b.note,
    }], { source: 'mobile', userId: req.user.id });
    if (!r1.inserted) throw bad('You already marked attendance this minute.');
    await flushDirty(db);
    res.json({ ok: true, time: now, inside: match.inside, place: match.inside ? n.branch.name : null, distance: n ? Math.round(n.distance) : null });
  });

  /* -------------------------------------------------------------- devices */
  crud(r, db, {
    path: 'devices', table: 'devices', perm: 'attendance.manage', order: 'name', label: 'Device', hasCreatedAt: true,
    spec: {
      name: ['str', { required: true, max: 100 }], kind: ['str', { oneOf: ['adms', 'api'], default: 'adms' }],
      serial_no: ['str', { max: 60 }], branch_id: ['id'], active: ['bool'],
    },
    decorate: (d) => { const { api_key_hash, ...rest } = d; return { ...rest, has_key: !!api_key_hash }; },
    async beforeSave(req, data, existing) {
      if (data.serial_no) {
        data.serial_no = data.serial_no.toUpperCase();
        const dup = await db.get('SELECT id FROM devices WHERE serial_no = ? AND id <> ?', [data.serial_no, existing ? existing.id : 0]);
        if (dup) throw bad('A machine with that serial number is already registered (maybe in another organization).');
      }
      const kind = data.kind || (existing && existing.kind);
      if (kind === 'adms' && !(data.serial_no || (existing && existing.serial_no))) throw bad('Enter the machine\'s serial number (shown in its System Info menu).');
    },
  });

  /** A new secret key for a device or the attendance agent. Shown once. */
  r.post('/devices/:id/key', need('attendance.manage'), async (req, res) => {
    const d = await db.get('SELECT * FROM devices WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!d) throw notFound('Device');
    const key = `bwd_${newToken()}`;
    await db.update('devices', { id: d.id }, { api_key_hash: sha256(key) });
    await audit(db, req, 'devices.key', 'devices', d.id);
    res.json({ key });
  });

  /**
   * Punch upload for the attendance agent or any integration: header "X-Device-Key: bwd_…",
   * body { punches: [{ user_id: "15", time: "2026-10-08 09:02:11", direction: "in" }] }.
   */
  r.post('/device/punches', async (req, res) => {
    const key = String(req.headers['x-device-key'] || '');
    const d = key ? await db.get('SELECT * FROM devices WHERE api_key_hash = ? AND active = 1', [sha256(key)]) : null;
    if (!d) throw new HttpError(401, 'Unknown device key.');
    const list = Array.isArray(req.body?.punches) ? req.body.punches : [];
    if (list.length > 20000) throw bad('Send at most 20000 punches at a time.');
    const result = await ingestPunches(db, d.org_id, list.map((p) => ({ device_user_id: p.user_id ?? p.device_user_id, time: p.time, direction: p.direction })), { source: 'device', deviceId: d.id });
    await db.update('devices', { id: d.id }, { last_seen_at: utcNow() });
    res.json(result);
  });

  /**
   * CSV import from any machine's export: columns for the person (machine number or employee
   * number) and the time (one "date time" column, or separate date and time columns).
   */
  r.post('/attendance/import', need('attendance.manage'), async (req, res) => {
    const text = String(req.body?.csv || '');
    if (!text.trim()) throw bad('The file is empty.');
    if (text.length > 6 * 1024 * 1024) throw bad('The file is too large (at most 6 MB).');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const sep = [',', ';', '\t'].map((s) => [s, (lines[0].match(new RegExp(s === '\t' ? '\t' : `\\${s}`, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
    const split = (l) => l.split(sep).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
    const header = split(lines[0]).map((h) => h.toLowerCase());
    const find = (...names) => header.findIndex((h) => names.some((n) => h === n || h.replace(/[\s_.-]/g, '') === n.replace(/[\s_.-]/g, '')));
    const col = {
      dev: find('ac-no.', 'ac-no', 'acno', 'user id', 'userid', 'enroll no', 'enrollno', 'machine no', 'device user id', 'pin', 'badge', 'card no'),
      code: find('employee code', 'emp code', 'emp_code', 'employee no', 'employee number', 'employee id', 'emp no', 'emp id'),
      datetime: find('datetime', 'date time', 'time stamp', 'timestamp', 'punch time', 'checktime', 'check time', 'date/time'),
      date: find('date', 'punch date', 'att date'),
      time: find('time', 'punch time only', 'clock'),
      dir: find('direction', 'state', 'in/out', 'type', 'check type'),
    };
    if (col.dev < 0 && col.code < 0) throw bad('Could not find a column with the machine number (e.g. "User ID", "AC-No.") or employee number ("Employee code").');
    if (col.datetime < 0 && (col.date < 0 || col.time < 0)) throw bad('Could not find the time: use a "DateTime" column, or "Date" and "Time" columns.');
    const codes = new Map((await db.all('SELECT id, emp_code FROM employees WHERE org_id = ?', [req.org.id])).map((e) => [e.emp_code.toLowerCase(), e.id]));
    const items = [];
    let bad1 = 0;
    for (const l of lines.slice(1)) {
      const c = split(l);
      let dt = col.datetime >= 0 ? c[col.datetime] : `${c[col.date]} ${c[col.time]}`;
      dt = normalizeDateTime(dt);
      if (!dt) { bad1++; continue; }
      const dirRaw = col.dir >= 0 ? String(c[col.dir] || '').toLowerCase() : '';
      const direction = /^(in|i|0|c\/in|checkin|check in)$/.test(dirRaw) ? 'in' : /^(out|o|1|c\/out|checkout|check out)$/.test(dirRaw) ? 'out' : 'auto';
      if (col.dev >= 0 && c[col.dev]) items.push({ device_user_id: c[col.dev], time: dt, direction });
      else if (col.code >= 0 && codes.has(String(c[col.code]).toLowerCase())) items.push({ employee_id: codes.get(String(c[col.code]).toLowerCase()), time: dt, direction });
      else bad1++;
    }
    const result = await ingestPunches(db, req.org.id, items, { source: 'import', userId: req.user.id });
    result.invalid += bad1;
    await flushDirty(db);
    await audit(db, req, 'attendance.import', null, null, result);
    res.json(result);
  });

  /* ------------------------------------------------ attendance corrections */
  r.get('/regularizations', inOrg, async (req, res) => {
    const scopeName = String(req.query.scope || 'mine');
    let sql = `SELECT g.*, e.first_name, e.last_name, e.emp_code FROM regularizations g JOIN employees e ON e.id = g.employee_id WHERE g.org_id = ?`;
    const params = [req.org.id];
    if (scopeName === 'mine') { sql += ' AND g.employee_id = ?'; params.push(req.member.employee_id || 0); }
    else if (scopeName === 'approvals') {
      if (req.perms.has('attendance.manage')) sql += " AND g.status = 'pending'";
      else { sql += " AND g.status = 'pending' AND g.approver_employee_id = ?"; params.push(req.member.employee_id || 0); }
    } else {
      const scope = await employeeScope(req, 'attendance.view');
      if (!scope.all) {
        const ids = [...(scope.team || [])];
        if (!ids.length) return res.json([]);
        sql += ` AND g.employee_id IN (${ids.map(() => '?').join(',')})`; params.push(...ids);
      }
    }
    if (req.query.status) { sql += ' AND g.status = ?'; params.push(String(req.query.status)); }
    const rows = await db.all(`${sql} ORDER BY g.id DESC LIMIT 300`, params);
    res.json(rows.map((x) => ({ ...x, name: fullName(x), chain: parseChain(x), can_act: canAct(req, x, 'attendance.manage') })));
  });

  r.post('/regularizations', inOrg, async (req, res) => {
    const empId = req.member.employee_id;
    if (!empId) throw bad('Your account is not linked to an employee record.');
    const b = pick(req.body, {
      work_date: ['date', { required: true }], in_time: ['time'], out_time: ['time'], reason: ['str', { required: true, max: 500 }],
    });
    if (!b.in_time && !b.out_time) throw bad('Enter the time you came in, left, or both.');
    if (b.work_date > today(req)) throw bad('You can only correct days that have passed.');
    if (b.work_date < addDays(today(req), -60)) throw bad('That day is too long ago. Please ask HR.');
    const dup = await db.get("SELECT id FROM regularizations WHERE employee_id = ? AND work_date = ? AND status = 'pending'", [empId, b.work_date]);
    if (dup) throw bad('You already have a pending correction for that day.');
    const { steps } = await buildChain(db, req.org, empId, today(req));
    const now = utcNow();
    const id = await db.insert('regularizations', {
      ...b, org_id: req.org.id, employee_id: empId, status: 'pending', chain: JSON.stringify(steps), step: 0, step_since: now,
      approver_employee_id: steps[0].type === 'employee' ? steps[0].id : null, created_by: req.user.id, created_at: now,
    });
    const row = await db.get('SELECT * FROM regularizations WHERE id = ?', [id]);
    await recordAction(db, req, 'regularization', row, 'submitted');
    const e = await db.get('SELECT first_name, last_name FROM employees WHERE id = ?', [empId]);
    await notifyStep(db, req.org, row, 'regularization', `${fullName(e)} asks to correct attendance on ${b.work_date}`);
    res.json({ id });
  });

  r.post('/regularizations/:id/decide', inOrg, async (req, res) => {
    const row = await db.get('SELECT * FROM regularizations WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!row) throw notFound('Correction');
    if (!canAct(req, row, 'attendance.manage')) throw forbidden('This request is not waiting for you.');
    if (row.employee_id === req.member.employee_id && !req.perms.has('attendance.manage')) throw forbidden('You cannot approve your own correction.');
    const approve = !!req.body?.approve;
    const comment = req.body?.comment ? String(req.body.comment).slice(0, 500) : null;
    if (!approve && !comment) throw bad('Please give a reason for rejecting.');
    const result = await decide(db, req, 'regularizations', 'regularization', row, approve, comment);
    if (result === 'approved') {
      const items = [];
      if (row.in_time) items.push({ employee_id: row.employee_id, time: `${row.work_date} ${row.in_time}`, direction: 'in', note: `Correction #${row.id}: ${row.reason}` });
      if (row.out_time) {
        const outDate = row.in_time && row.out_time < row.in_time ? addDays(row.work_date, 1) : row.work_date; // night shift
        items.push({ employee_id: row.employee_id, time: `${outDate} ${row.out_time}`, direction: 'out', note: `Correction #${row.id}: ${row.reason}` });
      }
      await ingestPunches(db, req.org.id, items, { source: 'manual', userId: req.user.id });
      await flushDirty(db);
      await notifyEmployees(db, req.org.id, [row.employee_id], `Your attendance correction for ${row.work_date} was approved`, comment, '#/me/attendance');
    } else if (result === 'rejected') {
      await notifyEmployees(db, req.org.id, [row.employee_id], `Your attendance correction for ${row.work_date} was not approved`, comment, '#/me/attendance');
    } else {
      const fresh = await db.get('SELECT * FROM regularizations WHERE id = ?', [row.id]);
      await notifyStep(db, req.org, fresh, 'regularization', `An attendance correction for ${row.work_date} needs your approval`);
    }
    await audit(db, req, `regularization.${result}`, 'regularizations', row.id, { comment });
    res.json({ result });
  });

  r.post('/regularizations/:id/cancel', inOrg, async (req, res) => {
    const row = await db.get('SELECT * FROM regularizations WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!row) throw notFound('Correction');
    if (row.employee_id !== req.member.employee_id && !req.perms.has('attendance.manage')) throw forbidden();
    if (row.status !== 'pending') throw bad('Only a pending correction can be cancelled.');
    await db.update('regularizations', { id: row.id }, { status: 'cancelled', decided_at: utcNow(), approver_employee_id: null });
    res.json({ ok: true });
  });
};

/** Accept the usual machine export formats and return 'YYYY-MM-DD HH:MM:SS', or null. */
function normalizeDateTime(s) {
  s = String(s || '').trim().replace('T', ' ');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
  let y; let mo; let d; let h; let mi; let se; let ap;
  if (m) [, y, mo, d, h, mi, se, ap] = m;
  else {
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return null;
    [, d, mo, y, h, mi, se, ap] = m; // day first (Pakistan, UK …)
  }
  h = Number(h);
  if (ap) { ap = ap.toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
  const p = (n) => String(n).padStart(2, '0');
  const out = `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(se || 0)}`;
  return isDate(out.slice(0, 10)) && h < 24 && Number(mi) < 60 ? out : null;
}

module.exports.normalizeDateTime = normalizeDateTime;
