'use strict';

/**
 * Attendance rules: turning a day's punches into a day status, and a month of days into the
 * figures payroll needs. Everything here is pure (no database), so it is easy to test and reason about.
 */

const { addDays, weekday, toMinutes, fromMinutes } = require('../lib/dates');

/** The shift as it applies on one date: { off, start, end, breakMinutes }. */
function shiftForDay(shift, date) {
  const wd = weekday(date);
  const offDays = String(shift.weekly_off || '').split(',').map((x) => Number(x.trim())).filter(Boolean);
  let overrides = shift.day_overrides || {};
  if (typeof overrides === 'string') { try { overrides = JSON.parse(overrides); } catch { overrides = {}; } }
  const o = overrides[String(wd)] || null;
  if (o && o.off) return { off: true, start: shift.start_time, end: shift.end_time, breakMinutes: 0 };
  if (o && o.start && o.end) return { off: false, start: o.start, end: o.end, breakMinutes: Number(o.break_minutes ?? shift.break_minutes) || 0 };
  return { off: offDays.includes(wd), start: shift.start_time, end: shift.end_time, breakMinutes: Number(shift.break_minutes) || 0 };
}

/**
 * The 24-hour window of punches that belong to a work date: from 4 hours before the shift starts
 * to 4 hours before it starts the next day. That handles night shifts that cross midnight.
 */
function dayWindow(date, startTime) {
  const s = toMinutes(`${date} ${startTime}:00`) - 240;
  return [s, s + 1440];
}

/** Minutes worked between first and last punch; punches within 2 minutes of each other count once. */
function cleanPunches(minutes) {
  const sorted = [...minutes].sort((a, b) => a - b);
  const out = [];
  for (const m of sorted) if (!out.length || m - out[out.length - 1] > 2) out.push(m);
  return out;
}

/**
 * One employee, one date.
 * input: {
 *   date, employee: { join_date, exit_date, attendance_required },
 *   shiftDay: from shiftForDay, rules: policy rules,
 *   holiday: { id, kind, treatment, name } | null,
 *   leave: { request_id, paid, half: 'none'|'first'|'second', count_off_days } | null,
 *   punches: [minutes since epoch] (already limited to this day's window)
 * }
 */
function processDay({ date, employee, shiftDay, rules, holiday = null, leave = null, punches = [] }) {
  const rec = {
    work_date: date,
    status: 'present',
    shift_start: shiftDay.start,
    shift_end: shiftDay.end,
    first_in: null,
    last_out: null,
    punch_count: 0,
    worked_minutes: 0,
    late_minutes: 0,
    early_minutes: 0,
    short_minutes: 0,
    overtime_minutes: 0,
    ot_rate: 0,
    deduction_days: 0,
    leave_request_id: leave ? leave.request_id : null,
    leave_paid: leave ? (leave.paid ? 1 : 0) : null,
    holiday_id: holiday ? holiday.id : null,
    remarks: '',
  };
  const notes = [];

  if (date < employee.join_date || (employee.exit_date && date > employee.exit_date)) {
    rec.status = 'not_employed';
    return rec;
  }

  const times = cleanPunches(punches);
  rec.punch_count = times.length;
  if (times.length) rec.first_in = fromMinutes(times[0]);
  if (times.length > 1) rec.last_out = fromMinutes(times[times.length - 1]);
  const worked = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  rec.worked_minutes = worked;

  const tracked = employee.attendance_required !== 0 && employee.attendance_required !== false;
  const closedHoliday = holiday && (holiday.kind === 'public' || holiday.treatment === 'closed');
  const offDay = shiftDay.off || closedHoliday;

  if (offDay) {
    if (leave && leave.count_off_days && leave.half === 'none') {
      rec.status = 'leave';
      rec.deduction_days = leave.paid ? 0 : 1;
      notes.push('Inside a leave (off days count)');
    } else {
      rec.status = closedHoliday ? 'holiday' : 'weekend';
      rec.leave_request_id = null;
      rec.leave_paid = null;
      if (closedHoliday) notes.push(holiday.name);
    }
    if (worked > 0) {
      notes.push('Worked on an off day');
      if (rules.overtime_enabled && worked >= rules.overtime_min_minutes) {
        rec.overtime_minutes = worked;
        rec.ot_rate = rules.overtime_offday_rate;
      }
    }
    rec.remarks = notes.join('; ');
    return rec;
  }

  if (leave && leave.half === 'none') {
    rec.status = 'leave';
    rec.deduction_days = leave.paid ? 0 : 1;
    rec.remarks = leave.paid ? '' : 'Unpaid leave';
    return rec;
  }

  // Expected start and end, in minutes since the epoch.
  let S = toMinutes(`${date} ${shiftDay.start}:00`);
  let E = toMinutes(`${date} ${shiftDay.end}:00`);
  if (E <= S) E += 1440; // night shift
  const fullRequired = E - S;
  if (holiday && holiday.kind === 'exceptional' && holiday.treatment === 'half_day') {
    E = S + Math.round(fullRequired / 2);
    notes.push(`${holiday.name} (half day)`);
  }
  let halfLeave = false;
  if (leave && (leave.half === 'first' || leave.half === 'second')) {
    halfLeave = true;
    const half = Math.round((E - S) / 2);
    if (leave.half === 'first') S += half; else E -= half;
    if (!leave.paid) rec.deduction_days += 0.5;
    notes.push(`Half-day leave (${leave.half} half)${leave.paid ? '' : ', unpaid'}`);
  }
  const relaxed = holiday && holiday.kind === 'exceptional' && holiday.treatment === 'relaxed';
  if (relaxed) notes.push(`${holiday.name}: attendance relaxed`);
  rec.shift_start = fromMinutes(S).slice(11, 16);
  rec.shift_end = fromMinutes(E).slice(11, 16);

  const required = E - S;
  const dayShare = halfLeave ? 0.5 : 1; // the part of the day the employee had to work
  const absentDeduction = rules.absent_deduction_days * dayShare;

  if (!tracked) {
    rec.status = halfLeave ? 'half_leave' : 'present';
    notes.push('Attendance not tracked');
    rec.remarks = notes.join('; ');
    return rec;
  }

  if (times.length === 0) {
    if (relaxed) {
      rec.status = halfLeave ? 'half_leave' : 'present';
    } else {
      rec.status = 'absent';
      rec.deduction_days += absentDeduction;
    }
    rec.remarks = notes.join('; ');
    return rec;
  }

  if (times.length === 1) {
    switch (rules.single_punch) {
      case 'present': rec.status = halfLeave ? 'half_leave' : 'present'; notes.push('Single punch counted as present'); break;
      case 'half_day': rec.status = 'half_day'; rec.deduction_days += 0.5 * dayShare; notes.push('Single punch counted as half day'); break;
      case 'absent': rec.status = 'absent'; rec.deduction_days += absentDeduction; notes.push('Single punch counted as absent'); break;
      default: rec.status = 'missing'; notes.push('Missing punch: please regularize');
    }
    if (rec.status !== 'absent' && !relaxed) {
      const late = times[0] - S;
      if (late > rules.grace_minutes && times[0] < E) rec.late_minutes = late;
    }
    rec.remarks = notes.join('; ');
    return rec;
  }

  const first = times[0];
  const last = times[times.length - 1];
  if (!relaxed) {
    const late = Math.max(0, first - S);
    rec.late_minutes = late > rules.grace_minutes ? late : 0;
    const early = Math.max(0, E - last);
    rec.early_minutes = early > rules.early_grace_minutes ? early : 0;
    rec.short_minutes = Math.max(0, required - worked);
  }

  rec.status = halfLeave ? 'half_leave' : 'present';
  const minForHalf = rules.min_minutes_for_half_day * dayShare;
  if (!relaxed && minForHalf > 0 && worked < minForHalf) {
    rec.status = 'absent';
    rec.deduction_days += absentDeduction;
    notes.push(`Worked only ${Math.floor(worked / 60)}h ${worked % 60}m`);
  } else if (!relaxed && rules.half_day_if_late_minutes > 0 && rec.late_minutes >= rules.half_day_if_late_minutes) {
    rec.status = 'half_day';
    rec.deduction_days += 0.5 * dayShare;
    notes.push('Very late: half day');
  } else if (!relaxed && rec.short_minutes > rules.full_day_tolerance_minutes) {
    if (rules.short_time_action === 'half_day') {
      rec.status = 'half_day';
      rec.deduction_days += 0.5 * dayShare;
      notes.push('Short time: half day');
    } else if (rules.short_time_action === 'hourly') {
      rec.deduction_days += Math.round((rec.short_minutes / fullRequired) * 1000) / 1000;
      notes.push('Short time deducted by the hour');
    }
  }

  if (rules.overtime_enabled) {
    const extra = last - E;
    if (extra >= rules.overtime_min_minutes) {
      rec.overtime_minutes = extra;
      rec.ot_rate = rules.overtime_rate;
    }
  }
  rec.remarks = notes.join('; ');
  return rec;
}

/** Is this day a "late" for the monthly late count? */
function isLateDay(d, rules) {
  if (!['present', 'missing', 'half_leave'].includes(d.status)) return false;
  return d.late_minutes > 0 || (rules.count_early_as_late && d.early_minutes > 0);
}

/**
 * Rules that need the whole range: the sandwich rule turns weekends and holidays between two
 * absences into absences. days must be one employee's records sorted by date.
 */
function applyRangeRules(days, rules) {
  if (!rules.sandwich_rule) return days;
  const isAbsent = (d) => d && d.status === 'absent';
  const isOff = (d) => d && (d.status === 'weekend' || d.status === 'holiday') && !d.manual;
  for (let i = 0; i < days.length; i++) {
    if (!isOff(days[i])) continue;
    let j = i;
    while (j < days.length && isOff(days[j])) j++;
    if (isAbsent(days[i - 1]) && isAbsent(days[j])) {
      for (let k = i; k < j; k++) {
        days[k].status = 'absent';
        days[k].deduction_days = rules.absent_deduction_days;
        days[k].remarks = [days[k].remarks, 'Sandwich rule'].filter(Boolean).join('; ');
      }
    }
    i = j - 1;
  }
  return days;
}

/** Month figures for payroll from a list of day records. */
function summarize(days, rules) {
  const s = {
    days: days.length, employed_days: 0, present_days: 0, absent_days: 0, half_days: 0, paid_leave_days: 0,
    unpaid_leave_days: 0, off_days: 0, missing_days: 0, late_count: 0, deduction_days: 0, absence_deduction_days: 0,
    worked_minutes: 0, ot_minutes: 0, ot_weighted_minutes: 0,
  };
  for (const d of days) {
    if (d.status === 'not_employed') continue;
    s.employed_days++;
    s.worked_minutes += d.worked_minutes || 0;
    switch (d.status) {
      case 'present': s.present_days++; break;
      case 'missing': s.present_days++; s.missing_days++; break;
      case 'half_day': s.present_days += 0.5; s.half_days++; break;
      case 'half_leave': s.present_days += 0.5; break;
      case 'absent': s.absent_days++; break;
      case 'weekend': case 'holiday': s.off_days++; break;
      default: break;
    }
    if (d.leave_request_id && d.status !== 'weekend' && d.status !== 'holiday') {
      const share = d.status === 'leave' ? 1 : 0.5;
      if (Number(d.leave_paid)) s.paid_leave_days += share; else s.unpaid_leave_days += share;
    }
    s.deduction_days += Number(d.deduction_days) || 0;
    // the part of the deduction that comes from absences / half days / short time, not unpaid leave
    const unpaidLeave = d.leave_request_id && !Number(d.leave_paid) && d.status !== 'weekend' && d.status !== 'holiday'
      ? (d.status === 'leave' ? 1 : 0.5) : 0;
    s.absence_deduction_days += Math.max(0, (Number(d.deduction_days) || 0) - unpaidLeave);
    if (isLateDay(d, rules)) s.late_count++;
    if (d.overtime_minutes) {
      s.ot_minutes += d.overtime_minutes;
      s.ot_weighted_minutes += d.overtime_minutes * (Number(d.ot_rate) || 1);
    }
  }
  const round3 = (n) => Math.round(n * 1000) / 1000;
  s.deduction_days = round3(s.deduction_days);
  s.absence_deduction_days = round3(s.absence_deduction_days);
  s.late_deduction_days = rules.lates_per_deduction > 0
    ? Math.floor(s.late_count / rules.lates_per_deduction) * rules.late_deduction_days : 0;
  return s;
}

/** Punches (minutes) for each date from a sorted list, given each date's window. */
function bucketPunches(dates, windowFor, punchMinutes) {
  const out = new Map(dates.map((d) => [d, []]));
  for (const m of punchMinutes) {
    for (const d of dates) {
      const [a, b] = windowFor(d);
      if (m >= a && m < b) { out.get(d).push(m); break; }
    }
  }
  return out;
}

module.exports = { shiftForDay, dayWindow, processDay, applyRangeRules, summarize, isLateDay, bucketPunches, cleanPunches, addDays };
